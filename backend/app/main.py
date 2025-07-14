# backend/app/main.py
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import google.generativeai as genai
import os
from dotenv import load_dotenv
import json
import requests
import asyncio
import aiofiles
import uuid
from pathlib import Path
import base64
from google.cloud import texttospeech
from google.cloud import speech
import tempfile
import io

load_dotenv()

# Configure Gemini API
api_key = os.getenv("GOOGLE_API_KEY")
genai.configure(api_key=api_key)
model = genai.GenerativeModel('gemini-2.0-flash')

# Configure TTS and Speech-to-Text
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = os.getenv("GOOGLE_CREDENTIALS_PATH", "")

app = FastAPI()

# Create directories for storing video files only (no audio storage)
VIDEO_DIR = Path("static/video")
TEMP_DIR = Path("temp")
VIDEO_DIR.mkdir(parents=True, exist_ok=True)
TEMP_DIR.mkdir(parents=True, exist_ok=True)

# Mount static files
app.mount("/static", StaticFiles(directory="static"), name="static")

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, replace with specific origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class SpeechToTextService:
    def __init__(self):
        self.client = speech.SpeechClient()

    async def transcribe_audio(self, audio_data: bytes) -> str:
        """Transcribe audio data to text using Google Speech-to-Text"""
        try:
            # Configure recognition
            config = speech.RecognitionConfig(
                encoding=speech.RecognitionConfig.AudioEncoding.WEBM_OPUS,
                sample_rate_hertz=48000,
                language_code="en-US",
                alternative_language_codes=["fr-FR"],  # Support français aussi
                enable_automatic_punctuation=True,
            )

            audio = speech.RecognitionAudio(content=audio_data)

            # Perform recognition
            response = self.client.recognize(config=config, audio=audio)

            # Extract transcribed text
            if response.results:
                transcribed_text = response.results[0].alternatives[0].transcript
                return transcribed_text.strip()
            else:
                return None

        except Exception as e:
            print(f"Speech-to-Text Error: {e}")
            # Fallback: try with different audio encoding
            try:
                config = speech.RecognitionConfig(
                    encoding=speech.RecognitionConfig.AudioEncoding.LINEAR16,
                    sample_rate_hertz=16000,
                    language_code="en-US",
                    enable_automatic_punctuation=True,
                )

                audio = speech.RecognitionAudio(content=audio_data)
                response = self.client.recognize(config=config, audio=audio)

                if response.results:
                    return response.results[0].alternatives[0].transcript.strip()

            except Exception as fallback_error:
                print(f"Speech-to-Text Fallback Error: {fallback_error}")

            return None

class TTSService:
    def __init__(self):
        self.client = texttospeech.TextToSpeechClient()

    async def synthesize_text_to_base64(self, text: str, language_code: str = "en-US") -> str:
        """
        Convert text to speech and return the audio as base64 string
        No file storage - direct streaming to frontend
        """
        try:
            # Create the synthesis request
            request = texttospeech.SynthesizeSpeechRequest(
                input=texttospeech.SynthesisInput(text=text),
                voice=texttospeech.VoiceSelectionParams(
                    language_code=language_code,
                    ssml_gender=texttospeech.SsmlVoiceGender.NEUTRAL
                ),
                audio_config=texttospeech.AudioConfig(
                    audio_encoding=texttospeech.AudioEncoding.MP3
                )
            )

            # Perform the text-to-speech request in executor to avoid blocking
            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(
                None,
                self.client.synthesize_speech,
                request
            )

            # Convert audio content to base64 for WebSocket transmission
            audio_base64 = base64.b64encode(response.audio_content).decode('utf-8')

            return audio_base64

        except Exception as e:
            print(f"TTS Error: {e}")
            return None

    async def synthesize_text_streaming(self, text: str, websocket: WebSocket, language_code: str = "en-US"):
        """
        Stream TTS audio directly via WebSocket in chunks
        For very long texts, this can be more efficient
        """
        try:
            # Create the synthesis request
            request = texttospeech.SynthesizeSpeechRequest(
                input=texttospeech.SynthesisInput(text=text),
                voice=texttospeech.VoiceSelectionParams(
                    language_code=language_code,
                    ssml_gender=texttospeech.SsmlVoiceGender.NEUTRAL
                ),
                audio_config=texttospeech.AudioConfig(
                    audio_encoding=texttospeech.AudioEncoding.MP3
                )
            )

            # Perform the text-to-speech request
            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(
                None,
                self.client.synthesize_speech,
                request
            )

            # Stream audio in chunks
            chunk_size = 4096  # 4KB chunks
            audio_data = response.audio_content

            # Send audio metadata first
            await websocket.send_text(json.dumps({
                "type": "audio_stream_start",
                "audio_length": len(audio_data),
                "content_type": "audio/mp3"
            }))

            # Send audio data in chunks
            for i in range(0, len(audio_data), chunk_size):
                chunk = audio_data[i:i + chunk_size]
                chunk_base64 = base64.b64encode(chunk).decode('utf-8')

                await websocket.send_text(json.dumps({
                    "type": "audio_chunk",
                    "chunk_data": chunk_base64,
                    "chunk_index": i // chunk_size,
                    "is_last": i + chunk_size >= len(audio_data)
                }))

            # Send completion signal
            await websocket.send_text(json.dumps({
                "type": "audio_stream_complete"
            }))

        except Exception as e:
            print(f"TTS Streaming Error: {e}")
            await websocket.send_text(json.dumps({
                "type": "error",
                "message": f"TTS streaming error: {str(e)}"
            }))

class ConnectionManager:
    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        self.active_connections.remove(websocket)

    async def send_response(self, websocket: WebSocket, data: dict):
        await websocket.send_text(json.dumps(data))

# Initialize services
manager = ConnectionManager()
speech_service = SpeechToTextService()
tts_service = TTSService()

async def process_question(websocket: WebSocket, question_text: str):
    """Process a question (from text or voice) and generate response"""
    try:
        print(f"Processing question: {question_text}")

        # 1. Get response from Gemini API
        response = model.generate_content(question_text)
        text_response = response.text

        # Send text response immediately
        await manager.send_response(websocket, {
            "type": "text_response",
            "text": text_response,
            "status": "processing_audio"
        })

        # 2. Convert text to speech and send as base64
        audio_base64 = await tts_service.synthesize_text_to_base64(text_response)

        if not audio_base64:
            await manager.send_response(websocket, {
                "type": "error",
                "message": "Failed to generate audio"
            })
            return

        # Send audio data directly via WebSocket
        await manager.send_response(websocket, {
            "type": "audio_ready",
            "audio_data": audio_base64,
            "audio_format": "mp3",
            "status": "processing_animation"
        })

        # Send final response
        await manager.send_response(websocket, {
            "type": "animation_ready",
            "text": text_response,
            "status": "completed"
        })

    except Exception as e:
        print(f"Error processing question: {e}")
        await manager.send_response(websocket, {
            "type": "error",
            "message": f"Error processing question: {str(e)}"
        })

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)

            if message.get("type") == "text_question":
                # Handle text question
                question_text = message.get("question", "")
                await process_question(websocket, question_text)

            elif message.get("type") == "voice_question":
                # Handle voice question
                audio_data_b64 = message.get("audio_data", "")
                try:
                    # Decode base64 audio data
                    audio_data = base64.b64decode(audio_data_b64)

                    # Transcribe audio to text
                    await manager.send_response(websocket, {
                        "type": "transcribing",
                        "status": "transcribing_audio"
                    })

                    transcribed_text = await speech_service.transcribe_audio(audio_data)

                    if not transcribed_text:
                        await manager.send_response(websocket, {
                            "type": "error",
                            "message": "Failed to transcribe audio"
                        })
                        continue

                    # Send transcribed text back to frontend
                    await manager.send_response(websocket, {
                        "type": "transcription_ready",
                        "transcribed_text": transcribed_text,
                        "status": "processing_response"
                    })

                    # Process the transcribed question
                    await process_question(websocket, transcribed_text)

                except Exception as e:
                    print(f"Voice processing error: {e}")
                    await manager.send_response(websocket, {
                        "type": "error",
                        "message": f"Voice processing error: {str(e)}"
                    })

            elif message.get("type") == "request_streaming_audio":
                # Handle streaming audio request
                question_text = message.get("question", "")
                try:
                    # Get response from Gemini API
                    response = model.generate_content(question_text)
                    text_response = response.text

                    # Send text response
                    await manager.send_response(websocket, {
                        "type": "text_response",
                        "text": text_response,
                        "status": "streaming_audio"
                    })

                    # Stream audio directly
                    await tts_service.synthesize_text_streaming(text_response, websocket)

                except Exception as e:
                    print(f"Streaming audio error: {e}")
                    await manager.send_response(websocket, {
                        "type": "error",
                        "message": f"Streaming audio error: {str(e)}"
                    })

            else:
                # Legacy support - treat as text question
                user_input = message.get("question", "")
                await process_question(websocket, user_input)

    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        print(f"WebSocket error: {e}")
        await manager.send_response(websocket, {
            "type": "error",
            "message": f"Server error: {str(e)}"
        })

@app.post("/transcribe")
async def transcribe_audio_endpoint(file: UploadFile = File(...)):
    """REST endpoint for audio transcription"""
    try:
        audio_data = await file.read()
        transcribed_text = await speech_service.transcribe_audio(audio_data)

        if transcribed_text:
            return {"transcribed_text": transcribed_text}
        else:
            return {"error": "Failed to transcribe audio"}

    except Exception as e:
        return {"error": f"Transcription error: {str(e)}"}

@app.get("/")
async def root():
    return {"message": "Audio2Face Avatar Backend with Google Speech-to-Text"}

@app.get("/health")
async def health_check():
    return {"status": "healthy"}