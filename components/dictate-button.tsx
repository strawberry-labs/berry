'use client';

import React, { useState, useRef, useCallback } from 'react';
import { Button } from './ui/button';
import { Mic, Square, LoaderCircle } from 'lucide-react';
import type { UseChatHelpers } from '@ai-sdk/react';
import type { ChatMessage } from '@/lib/types';

interface DictateButtonProps {
  onTranscriptionReceived: (text: string) => void;
  status: UseChatHelpers<ChatMessage>['status'];
}

export function DictateButton({ onTranscriptionReceived, status }: DictateButtonProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const transcribeAudio = useCallback(async (audioBlob: Blob) => {
    try {
      // Create form data to send to our API route
      const formData = new FormData();
      const audioFile = new File([audioBlob], 'recording.webm', { type: 'audio/webm' });
      formData.append('audio', audioFile);

      // Call our speech-to-text API route
      const response = await fetch('/api/speech-to-text', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to transcribe audio');
      }

      const result = await response.json();
      
      if (result.transcription) {
        onTranscriptionReceived(result.transcription);
      }
    } catch (error) {
      // Error transcribing audio
    } finally {
      setIsTranscribing(false);
    }
  }, [onTranscriptionReceived]);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 16000,
        } 
      });

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm;codecs=opus',
      });
      
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(chunksRef.current, { type: 'audio/webm;codecs=opus' });
        stream.getTracks().forEach(track => track.stop());
        await transcribeAudio(audioBlob);
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (error) {
      // Error starting recording
    }
  }, [transcribeAudio]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      setIsTranscribing(true);
    }
  }, [isRecording]);


  const handleClick = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    
    if (status !== 'ready') {
      return;
    }

    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }, [isRecording, startRecording, stopRecording, status]);

  const isDisabled = status !== 'ready' || isTranscribing;
  const isActive = isRecording || isTranscribing;

  return (
    <Button
      data-testid="dictate-button"
      className={`h-10 w-10 p-2 rounded-full hover:bg-[#252626] hover:text-foreground relative cursor-pointer ${
        isActive ? 'bg-red-100 dark:bg-red-900/20 text-red-600 dark:text-red-400' : 'text-muted-foreground'
      }`}
      onClick={handleClick}
      disabled={isDisabled}
      variant="ghost"
      title={
        isRecording 
          ? 'Stop recording' 
          : isTranscribing 
          ? 'Transcribing...' 
          : 'Start voice dictation'
      }
    >
      <div className="relative">
        {isTranscribing ? (
          <LoaderCircle size={18} className="animate-spin" />
        ) : isRecording ? (
          <Square size={18} />
        ) : (
          <Mic size={18} />
        )}
      </div>
    </Button>
  );
} 