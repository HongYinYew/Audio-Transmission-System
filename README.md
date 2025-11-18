# Live Audio Transmission System

A Python-based web application for live audio transmission with dynamic channels based on languages.

## Features

- Transmitter frontend: Capture audio from interpreter, specify language to create a channel.
- Client frontend: Select from available channels and listen to live audio.
- WebSocket-based real-time audio streaming.
- Dynamic channels: Channels are created when a transmitter starts for a new language.

## Requirements

- Python 3.8+
- FastAPI
- Uvicorn

## Installation

1. Install dependencies:
   ```
   pip install -r requirements.txt
   ```

## Running the Server

Run the server:
```
uvicorn server:app --host 0.0.0.0 --port 8000
```

The server will be accessible at `http://<your-ip>:8000`

## Usage

### Transmitter
- Go to `http://<your-ip>:8000/transmitter`
- Enter the language (e.g., "English")
- Click "Start Transmitting" to begin capturing and streaming audio.

### Client
- Go to `http://<your-ip>:8000/client`
- Click "Refresh Channels" to see available languages.
- Select a channel and click "Join Channel" to start listening.

## Notes

- One transmitter per language channel.
- Audio is streamed in real-time using WebSockets.
- Ensure microphone permissions are granted for transmitter.