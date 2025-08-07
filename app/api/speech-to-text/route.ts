import { NextRequest, NextResponse } from 'next/server';
import { fal } from '@fal-ai/client';

export async function POST(request: NextRequest) {
  try {
    // Check if FAL_KEY is configured
    if (!process.env.FAL_KEY) {
      console.error('FAL_KEY environment variable is not set');
      return NextResponse.json(
        { error: 'Speech-to-text service not configured' },
        { status: 500 }
      );
    }

    // Configure FAL client with API key
    fal.config({
      credentials: process.env.FAL_KEY,
    });

    console.log('Processing speech-to-text request...');
    
    const formData = await request.formData();
    const audioFile = formData.get('audio') as File;

    if (!audioFile) {
      console.error('No audio file provided in request');
      return NextResponse.json(
        { error: 'No audio file provided' },
        { status: 400 }
      );
    }

    console.log(`Audio file received: ${audioFile.name}, size: ${audioFile.size}, type: ${audioFile.type}`);

    // Upload the audio file to FAL storage
    console.log('Uploading audio to FAL storage...');
    const audioUrl = await fal.storage.upload(audioFile);
    console.log('Audio uploaded successfully, URL:', audioUrl);

    // Call FAL Wizper (Whisper) API
    console.log('Calling FAL Wizper API...');
    
    const result = await fal.subscribe("fal-ai/wizper", {
      input: {
        audio_url: audioUrl,
        task: 'transcribe',
        language: 'en',
        chunk_level: 'segment',
        version: '3'
      },
      logs: true,
      onQueueUpdate: (update) => {
        console.log('Queue update:', update.status);
        if (update.status === 'IN_PROGRESS') {
          update.logs?.map((log) => log.message).forEach(console.log);
        }
      },
    });

    console.log('FAL API result:', JSON.stringify(result, null, 2));

    // For Wizper, the transcription is in result.data.text
    const transcription = result.data?.text;
    
    if (transcription) {
      console.log('Transcription successful:', transcription);
      return NextResponse.json({ transcription });
    } else {
      console.error('No transcription in result:', result);
      return NextResponse.json(
        { error: 'No transcription received from service' },
        { status: 500 }
      );
    }
  } catch (error: any) {
    console.error('Error in speech-to-text API:', error);
    console.error('Error details:', {
      message: error.message,
      status: error.status,
      body: error.body,
      stack: error.stack
    });
    
    return NextResponse.json(
      { 
        error: 'Failed to process audio',
        details: error.message || 'Unknown error'
      },
      { status: 500 }
    );
  }
} 