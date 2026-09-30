# AssemblyAI Live Voice Recorder

A simple HTML, CSS, and JavaScript microphone recorder that displays AssemblyAI streaming transcripts in the DOM as you speak.

## How it works

- The browser obtains the microphone with `getUserMedia()`.
- `MediaRecorder` records the session and enables the **Download audio** button.
- The same `MediaStream` is converted to 16 kHz, mono, signed 16-bit PCM and sent to the local Node.js server.
- The Node.js server uses `ws` to securely forward binary audio to AssemblyAI Streaming v3.
- Partial and final `Turn` messages update the transcript without duplicating partial text.

The permanent AssemblyAI API key is read only by the server. It is never included in browser JavaScript.

## Setup

Requirements: Node.js 18 or newer and an AssemblyAI API key.

```bash
npm install
```

Copy `.env.example` to `.env` and add a newly generated API key:

```env
ASSEMBLYAI_API_KEY=your_new_key_here
PORT=3000
```

Start the application:

```bash
npm start
```

Open <http://localhost:3000>, select **Start recording**, allow microphone access, and begin speaking.

## Important notes

- Rotate the API key that was pasted into chat before running this project.
- Microphone access works on `localhost` during development. In production, serve the app over HTTPS so the browser will permit `getUserMedia()`.
- AssemblyAI streaming usage is billed for the time the upstream WebSocket remains open. The Stop button sends `Terminate` and waits for the final transcript.
- `ScriptProcessorNode` is used to keep this starter dependency-free. For a high-traffic production app, move PCM processing into an `AudioWorklet`.
