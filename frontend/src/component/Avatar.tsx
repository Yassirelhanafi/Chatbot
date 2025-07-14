// frontend/src/components/Avatar.tsx
import React, { useState, useEffect, useRef } from 'react';
import './Avatar.css';

interface AvatarProps {
    serverUrl: string;
}

interface MessageData {
    type: string;
    text?: string;
    audio_url?: string;
    audio_data?: string; // Base64 audio data
    audio_format?: string; // Audio format (mp3, wav, etc.)
    video_stream_url?: string;
    status?: string;
    message?: string;
    transcribed_text?: string;
    response?: string;
    // Streaming audio properties
    audio_length?: number;
    content_type?: string;
    chunk_data?: string;
    chunk_index?: number;
    is_last?: boolean;
}

const Avatar: React.FC<AvatarProps> = ({ serverUrl }) => {
    const [connected, setConnected] = useState<boolean>(false);
    const [question, setQuestion] = useState<string>('');
    const [response, setResponse] = useState<string>('');
    const [speaking, setSpeaking] = useState<boolean>(false);
    const [status, setStatus] = useState<string>('idle');
    const [audioUrl, setAudioUrl] = useState<string>('');
    const [videoStreamUrl, setVideoStreamUrl] = useState<string>('');
    const [isRecording, setIsRecording] = useState<boolean>(false);
    const [transcribedText, setTranscribedText] = useState<string>('');
    const [audioSupported, setAudioSupported] = useState<boolean>(true);

    const socketRef = useRef<WebSocket | null>(null);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    // For streaming audio
    const streamingAudioChunksRef = useRef<string[]>([]);

    // Connect to WebSocket
    useEffect(() => {
        // Ensure serverUrl includes port, default to 8000 if not specified
        let wsUrl = serverUrl;
        if (!/:[0-9]+$/.test(serverUrl)) {
            wsUrl = `${serverUrl}:8000`;
        }
        socketRef.current = new WebSocket(`ws://${wsUrl}/ws`);

        socketRef.current.onopen = () => {
            setConnected(true);
            setStatus('connected');
        };

        socketRef.current.onmessage = (event) => {
            const data: MessageData = JSON.parse(event.data);
            handleServerMessage(data);
        };

        socketRef.current.onclose = () => {
            setConnected(false);
            setStatus('disconnected');
            setSpeaking(false);
        };

        socketRef.current.onerror = (error) => {
            console.error('WebSocket error:', error);
            setStatus('error');
        };

        return () => {
            if (socketRef.current) {
                socketRef.current.close();
            }
        };
    }, [serverUrl]);

    // Handle different types of server messages
    const handleServerMessage = (data: MessageData) => {
        switch (data.type) {
            case 'transcribing':
                setStatus(data.status || 'transcribing');
                break;

            case 'transcription_ready':
                setTranscribedText(data.transcribed_text || '');
                setQuestion(data.transcribed_text || '');
                setStatus(data.status || 'processing');
                break;

            case 'text_response':
                setResponse(data.text || '');
                setStatus(data.status || 'processing');
                break;

            case 'audio_ready':
                // Handle base64 audio data from WebSocket
                if (data.audio_data) {
                    playAudioFromBase64(data.audio_data, data.audio_format || 'mp3');
                } else if (data.audio_url) {
                    // Fallback to URL-based audio
                    setAudioUrl(data.audio_url);
                    playAudio(data.audio_url);
                }
                setStatus(data.status || 'processing');
                break;

            case 'animation_ready':
                setVideoStreamUrl(data.video_stream_url || '');
                setStatus(data.status || 'completed');
                if (data.video_stream_url) {
                    playVideo(data.video_stream_url);
                }
                break;

            // Streaming audio handling
            case 'audio_stream_start':
                streamingAudioChunksRef.current = [];
                setStatus('receiving_audio');
                break;

            case 'audio_chunk':
                if (data.chunk_data) {
                    streamingAudioChunksRef.current.push(data.chunk_data);
                }
                break;

            case 'audio_stream_complete':
                // Combine all audio chunks and play
                const combinedAudioData = streamingAudioChunksRef.current.join('');
                playAudioFromBase64(combinedAudioData, 'mp3');
                streamingAudioChunksRef.current = [];
                setStatus('completed');
                break;

            case 'error':
                console.error('Server error:', data.message);
                setStatus('error');
                setSpeaking(false);
                setIsRecording(false);
                break;

            default:
                // Legacy support for old message format
                setResponse(data.text || data.response || '');
                if (data.text || data.response) {
                    triggerAudio2Face(data.text || data.response || '');
                }
        }
    };

    // Function to send text messages to the server
    const sendQuestion = (e: React.FormEvent) => {
        e.preventDefault();
        if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
            console.error("WebSocket not connected");
            return;
        }

        const message = JSON.stringify({
            type: "text_question",
            question
        });
        socketRef.current.send(message);
        setQuestion('');
        setResponse('');
        setTranscribedText('');
        setStatus('processing');
        setSpeaking(false);
    };

    // Function to request streaming audio
    const requestStreamingAudio = (questionText: string) => {
        if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
            console.error("WebSocket not connected");
            return;
        }

        const message = JSON.stringify({
            type: "request_streaming_audio",
            question: questionText
        });
        socketRef.current.send(message);
    };

    // Voice recording functions
    const startRecording = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const mediaRecorder = new MediaRecorder(stream);
            mediaRecorderRef.current = mediaRecorder;
            audioChunksRef.current = [];

            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    audioChunksRef.current.push(event.data);
                }
            };

            mediaRecorder.onstop = async () => {
                const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/wav' });
                await sendVoiceQuestion(audioBlob);

                // Stop all tracks
                stream.getTracks().forEach(track => track.stop());
            };

            mediaRecorder.start();
            setIsRecording(true);
            setStatus('recording');
        } catch (error) {
            console.error('Error starting recording:', error);
            setStatus('error');
        }
    };

    const stopRecording = () => {
        if (mediaRecorderRef.current && isRecording) {
            mediaRecorderRef.current.stop();
            setIsRecording(false);
            setStatus('processing_voice');
        }
    };

    const sendVoiceQuestion = async (audioBlob: Blob) => {
        if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
            console.error("WebSocket not connected");
            return;
        }

        try {
            // Convert audio blob to base64
            const arrayBuffer = await audioBlob.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);
            let binaryString = '';
            for (let i = 0; i < uint8Array.length; i++) {
                binaryString += String.fromCharCode(uint8Array[i]);
            }
            const base64Audio = btoa(binaryString);

            const message = JSON.stringify({
                type: "voice_question",
                audio_data: base64Audio
            });

            socketRef.current.send(message);
            setResponse('');
            setTranscribedText('');
            setStatus('transcribing');
            setSpeaking(false);
        } catch (error) {
            console.error('Error sending voice question:', error);
            setStatus('error');
        }
    };

    // Play audio from base64 data
    const playAudioFromBase64 = (base64Data: string, format: string = 'mp3') => {
        try {
            if (!audioRef.current) return;

            // Create a blob from base64 data
            const binaryString = atob(base64Data);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }

            const audioBlob = new Blob([bytes], { type: `audio/${format}` });
            const audioUrl = URL.createObjectURL(audioBlob);

            // Clean up previous object URL
            if (audioRef.current.src && audioRef.current.src.startsWith('blob:')) {
                URL.revokeObjectURL(audioRef.current.src);
            }

            audioRef.current.src = audioUrl;
            audioRef.current.play().catch(error => {
                console.error('Error playing audio from base64:', error);
                setAudioSupported(false);
            });
        } catch (error) {
            console.error('Error processing base64 audio:', error);
            setAudioSupported(false);
        }
    };

    // Play audio file (legacy support)
    const playAudio = (audioUrl: string) => {
        if (audioRef.current) {
            const fullUrl = audioUrl.startsWith('http') ? audioUrl : `http://${serverUrl}:8000${audioUrl}`;
            audioRef.current.src = fullUrl;
            audioRef.current.play().catch(error => {
                console.error('Error playing audio:', error);
                setAudioSupported(false);
            });
        }
    };

    // Play video stream
    const playVideo = (videoUrl: string) => {
        if (videoRef.current && videoUrl) {
            videoRef.current.src = videoUrl;
            videoRef.current.play().catch(error => {
                console.error('Error playing video:', error);
            });
        }
    };

    // Handle audio playback events
    const handleAudioStart = () => {
        setSpeaking(true);
        setStatus('speaking');
    };

    const handleAudioEnd = () => {
        setSpeaking(false);
        setStatus('idle');

        // Clean up blob URL if it was created
        if (audioRef.current?.src && audioRef.current.src.startsWith('blob:')) {
            URL.revokeObjectURL(audioRef.current.src);
        }
    };

    const handleAudioError = () => {
        console.error('Audio playback error');
        setSpeaking(false);
        setStatus('error');
        setAudioSupported(false);
    };

    // Legacy function for backward compatibility
    const triggerAudio2Face = (text: string) => {
        setSpeaking(true);
        setStatus('speaking');

        // Simulated speaking duration (fallback if no audio/video)
        setTimeout(() => {
            setSpeaking(false);
            setStatus('idle');
        }, 3000);
    };

    // Get status display text
    const getStatusText = () => {
        switch (status) {
            case 'recording': return 'Recording...';
            case 'processing_voice': return 'Processing voice...';
            case 'transcribing': return 'Transcribing audio...';
            case 'transcribing_audio': return 'Converting speech to text...';
            case 'processing_response': return 'Generating response...';
            case 'processing': return 'Processing...';
            case 'processing_audio': return 'Generating speech...';
            case 'processing_animation': return 'Creating animation...';
            case 'receiving_audio': return 'Receiving audio...';
            case 'speaking': return 'Speaking...';
            case 'completed': return 'Ready';
            case 'error': return 'Error occurred';
            case 'connected': return 'Connected';
            case 'disconnected': return 'Disconnected';
            default: return 'Idle';
        }
    };

    const isProcessing = [
        'processing',
        'recording',
        'processing_voice',
        'transcribing',
        'transcribing_audio',
        'processing_response',
        'processing_audio',
        'processing_animation',
        'receiving_audio'
    ].includes(status);

    return (
        <div className="avatar-container">
            <div className={`avatar ${speaking ? 'speaking' : ''} ${status}`}>
                {/* Video player for Audio2Face stream */}
                {videoStreamUrl ? (
                    <video
                        ref={videoRef}
                        className="avatar-video"
                        autoPlay
                        muted
                        loop
                        onError={() => console.error('Video playback error')}
                    />
                ) : (
                    <div className="avatar-placeholder">
                        <div className="avatar-face">
                            {speaking ? '😊' : isRecording ? '🎙️' : '😐'}
                        </div>
                        <div className="avatar-status">
                            {getStatusText()}
                        </div>
                    </div>
                )}
            </div>

            {/* Hidden audio element for TTS playback */}
            <audio
                ref={audioRef}
                onPlay={handleAudioStart}
                onEnded={handleAudioEnd}
                onError={handleAudioError}
                preload="none"
            />

            <div className="chat-interface">
                <div className="response-area">
                    {transcribedText && (
                        <div className="transcribed-text">
                            <strong>You said:</strong> "{transcribedText}"
                        </div>
                    )}
                    <div className="response-text">
                        {response}
                    </div>
                    {audioUrl && (
                        <div className="audio-controls">
                            <button
                                onClick={() => playAudio(audioUrl)}
                                disabled={speaking}
                            >
                                🔊 Play Audio
                            </button>
                        </div>
                    )}
                    {!audioSupported && (
                        <div className="audio-warning">
                            ⚠️ Audio playback not supported in this browser
                        </div>
                    )}
                </div>

                <div className="input-section">
                    {/* Voice input */}
                    <div className="voice-controls">
                        <button
                            onClick={isRecording ? stopRecording : startRecording}
                            disabled={!connected || (isProcessing && !isRecording)}
                            className={`voice-button ${isRecording ? 'recording' : ''}`}
                        >
                            {isRecording ? '⏹️ Stop' : '🎙️ Voice'}
                        </button>
                    </div>

                    {/* Text input */}
                    <form onSubmit={sendQuestion} className="question-form">
                        <input
                            type="text"
                            value={question}
                            onChange={(e) => setQuestion(e.target.value)}
                            placeholder="Ask a question or use voice..."
                            disabled={!connected || isProcessing}
                            className="question-input"
                        />
                        <button
                            type="submit"
                            disabled={!connected || isProcessing || question.trim() === ''}
                            className="send-button"
                        >
                            {isProcessing ? 'Processing...' : 'Send'}
                        </button>
                    </form>


                </div>

                <div className={`connection-status ${connected ? 'connected' : 'disconnected'}`}>
                    <div className="status-indicator"></div>
                    <span>{getStatusText()}</span>
                </div>
            </div>
        </div>
    );
};

export default Avatar;