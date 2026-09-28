import { useCallback, useRef, useState } from "react";
import { api } from "../api";
import { useToast } from "../components/Toast";

const MAX_RECORDING_MS = 60_000;

export function useVoice(incidentId: string | null, token: string, onTranscript: (text: string) => void) {
  const toast = useToast();
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);

  const stop = useCallback(() => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    setRecording(false);
  }, []);

  const start = useCallback(async () => {
    if (!incidentId || recording) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const form = new FormData();
        form.append("audio", new Blob(chunks, { type: recorder.mimeType || "audio/webm" }), "clip.webm");
        setTranscribing(true);
        try {
          const { transcript } = await api<{ transcript: string }>(token, `/incidents/${incidentId}/voice`, { method: "POST", body: form });
          onTranscript(transcript);
          toast.info("Transcript ready: review it, then press Send");
        } catch (err) {
          toast.error(`Transcription failed: ${(err as Error).message}`);
        } finally {
          setTranscribing(false);
        }
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
      setTimeout(() => recorder.state === "recording" && recorder.stop(), MAX_RECORDING_MS);
    } catch (err) {
      toast.error(`Microphone unavailable: ${(err as Error).message}`);
    }
  }, [incidentId, token, recording, onTranscript, toast]);

  return { recording, transcribing, start, stop };
}
