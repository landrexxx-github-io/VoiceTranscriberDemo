const SAMPLE_RATE = 16_000;
const METER_BAR_COUNT = 36;

const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");
const downloadButton = document.querySelector("#downloadButton");
const clearButton = document.querySelector("#clearButton");
const status = document.querySelector("#status");
const statusText = document.querySelector("#statusText");
const timer = document.querySelector("#timer");
const meterBars = document.querySelector("#meterBars");
const liveLabel = document.querySelector("#liveLabel");
const placeholder = document.querySelector("#placeholder");
const finalTranscript = document.querySelector("#finalTranscript");
const partialTranscript = document.querySelector("#partialTranscript");
const transcript = document.querySelector("#transcript");
const errorMessage = document.querySelector("#errorMessage");

let socket;
let mediaStream;
let mediaRecorder;
let audioContext;
let sourceNode;
let processorNode;
let silentGain;
let analyserNode;
let animationFrame;
let timerInterval;
let startedAt;
let recordingChunks = [];
let recordingUrl;
const completedTurns = new Map();

for (let index = 0; index < METER_BAR_COUNT; index += 1) {
  const bar = document.createElement("span");
  bar.className = "meter-bar";
  meterBars.appendChild(bar);
}

const bars = [...meterBars.children];

function setStatus(state, label) {
  status.dataset.state = state;
  statusText.textContent = label;
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.hidden = false;
  setStatus("error", "Error");
}

function hideError() {
  errorMessage.hidden = true;
  errorMessage.textContent = "";
}

function getSocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

function chooseRecordingMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/ogg;codecs=opus",
    "audio/webm",
    "audio/ogg",
  ];

  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function floatToInt16Buffer(float32) {
  const buffer = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buffer);

  for (let index = 0; index < float32.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, float32[index]));
    view.setInt16(
      index * 2,
      sample < 0 ? sample * 0x8000 : sample * 0x7fff,
      true,
    );
  }

  return buffer;
}

function downsample(input, inputRate, outputRate) {
  if (inputRate === outputRate) return input;

  const ratio = inputRate / outputRate;
  const length = Math.round(input.length / ratio);
  const result = new Float32Array(length);
  let outputIndex = 0;
  let inputIndex = 0;

  while (outputIndex < length) {
    const nextInputIndex = Math.round((outputIndex + 1) * ratio);
    let total = 0;
    let count = 0;

    for (
      let index = inputIndex;
      index < nextInputIndex && index < input.length;
      index += 1
    ) {
      total += input[index];
      count += 1;
    }

    result[outputIndex] = count ? total / count : 0;
    outputIndex += 1;
    inputIndex = nextInputIndex;
  }

  return result;
}

function renderCompletedTurns() {
  finalTranscript.replaceChildren();

  [...completedTurns.entries()]
    .sort(([first], [second]) => first - second)
    .forEach(([, text]) => {
      const paragraph = document.createElement("p");
      paragraph.className = "transcript-turn";
      paragraph.textContent = text;
      finalTranscript.appendChild(paragraph);
    });
}

function handleTurn(event) {
  placeholder.hidden = true;

  if (event.end_of_turn) {
    if (event.transcript.trim()) {
      completedTurns.set(event.turn_order, event.transcript.trim());
      renderCompletedTurns();
    }
    partialTranscript.textContent = "";
  } else {
    partialTranscript.textContent = event.transcript;
  }

  transcript.scrollTop = transcript.scrollHeight;
}

function handleServerEvent(event) {
  switch (event.type) {
    case "Begin":
      setStatus("recording", "Recording");
      break;
    case "Turn":
      handleTurn(event);
      break;
    case "Termination":
      setStatus("idle", "Complete");
      if (socket?.readyState === WebSocket.OPEN) socket.close();
      break;
    case "Error":
    case "ProxyError":
    case "ProxyClosed":
      showError(
        event.message || event.error || "Transcription stopped unexpectedly.",
      );
      stopCapture({ terminate: false });
      break;
    default:
      break;
  }
}

function startTimer() {
  startedAt = Date.now();
  timer.textContent = "00:00";
  timerInterval = window.setInterval(() => {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    const minutes = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const seconds = String(elapsed % 60).padStart(2, "0");
    timer.textContent = `${minutes}:${seconds}`;
  }, 250);
}

function drawMeter() {
  const values = new Uint8Array(analyserNode.frequencyBinCount);

  const draw = () => {
    analyserNode.getByteFrequencyData(values);
    const groupSize = Math.max(1, Math.floor(values.length / bars.length));

    bars.forEach((bar, index) => {
      let sum = 0;
      const start = index * groupSize;
      for (
        let item = start;
        item < start + groupSize && item < values.length;
        item += 1
      ) {
        sum += values[item];
      }
      const average = sum / groupSize;
      bar.style.transform = `scaleY(${Math.max(1, average / 22)})`;
    });

    animationFrame = requestAnimationFrame(draw);
  };

  draw();
}

function startPcmStream() {
  audioContext = new AudioContext();
  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  analyserNode = audioContext.createAnalyser();
  analyserNode.fftSize = 256;

  // ScriptProcessor keeps this demo dependency-free. For a heavily used
  // production app, move the same PCM conversion into an AudioWorklet.
  processorNode = audioContext.createScriptProcessor(4096, 1, 1);
  silentGain = audioContext.createGain();
  silentGain.gain.value = 0;

  processorNode.onaudioprocess = (audioEvent) => {
    if (socket?.readyState !== WebSocket.OPEN) return;

    const input = audioEvent.inputBuffer.getChannelData(0);
    const pcm = downsample(input, audioContext.sampleRate, SAMPLE_RATE);
    socket.send(floatToInt16Buffer(pcm));
  };

  sourceNode.connect(analyserNode);
  sourceNode.connect(processorNode);
  processorNode.connect(silentGain);
  silentGain.connect(audioContext.destination);
  drawMeter();
}

function startMediaRecorder() {
  recordingChunks = [];
  const mimeType = chooseRecordingMimeType();
  mediaRecorder = new MediaRecorder(
    mediaStream,
    mimeType ? { mimeType } : undefined,
  );

  mediaRecorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) recordingChunks.push(event.data);
  });

  mediaRecorder.addEventListener("stop", () => {
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    const type = mediaRecorder.mimeType || "audio/webm";
    const blob = new Blob(recordingChunks, { type });
    recordingUrl = URL.createObjectURL(blob);
    downloadButton.disabled = blob.size === 0;
  });

  mediaRecorder.start(1_000);
}

async function startRecording() {
  hideError();
  startButton.disabled = true;
  downloadButton.disabled = true;
  setStatus("connecting", "Connecting");

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    socket = new WebSocket(getSocketUrl());
    socket.binaryType = "arraybuffer";

    socket.addEventListener("open", () => {
      startMediaRecorder();
      startPcmStream();
      startTimer();
      stopButton.disabled = false;
      liveLabel.hidden = false;
    });

    socket.addEventListener("message", (message) => {
      try {
        handleServerEvent(JSON.parse(message.data));
      } catch {
        showError("The server returned an unreadable response.");
      }
    });

    socket.addEventListener("error", () => {
      showError("Could not connect to the local transcription server.");
      stopCapture({ terminate: false });
    });

    socket.addEventListener("close", () => {
      if (!stopButton.disabled) stopCapture({ terminate: false });
    });
  } catch (error) {
    const message =
      error.name === "NotAllowedError"
        ? "Microphone access was denied. Allow microphone access and try again."
        : `Could not start the microphone: ${error.message}`;
    showError(message);
    startButton.disabled = false;
  }
}

function stopCapture({ terminate = true } = {}) {
  stopButton.disabled = true;
  startButton.disabled = false;
  liveLabel.hidden = true;
  window.clearInterval(timerInterval);
  cancelAnimationFrame(animationFrame);
  bars.forEach((bar) => {
    bar.style.transform = "scaleY(1)";
  });

  if (processorNode) {
    processorNode.onaudioprocess = null;
    processorNode.disconnect();
  }
  sourceNode?.disconnect();
  analyserNode?.disconnect();
  silentGain?.disconnect();
  audioContext?.close();
  mediaStream?.getTracks().forEach((track) => track.stop());

  if (mediaRecorder?.state === "recording") mediaRecorder.stop();

  if (terminate && socket?.readyState === WebSocket.OPEN) {
    setStatus("finalizing", "Finalizing");
    socket.send(JSON.stringify({ type: "Terminate" }));
  } else if (status.dataset.state !== "error") {
    setStatus("idle", "Ready");
  }
}

function clearTranscript() {
  completedTurns.clear();
  finalTranscript.replaceChildren();
  partialTranscript.textContent = "";
  placeholder.hidden = false;
}

function downloadRecording() {
  if (!recordingUrl) return;
  const extension = mediaRecorder?.mimeType.includes("ogg") ? "ogg" : "webm";
  const link = document.createElement("a");
  link.href = recordingUrl;
  link.download = `voice-recording-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`;
  link.click();
}

startButton.addEventListener("click", startRecording);
stopButton.addEventListener("click", () => stopCapture());
clearButton.addEventListener("click", clearTranscript);
downloadButton.addEventListener("click", downloadRecording);

window.addEventListener("beforeunload", () => {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "Terminate" }));
  }
  mediaStream?.getTracks().forEach((track) => track.stop());
});
