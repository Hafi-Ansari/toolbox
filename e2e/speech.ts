// out/speech.wav for the transcription tests: two spoken passages with a 20 s silence between
// them, made by Windows' built-in speech synthesizer (System.Speech). Synthetic, so nothing real is
// committed. Elsewhere there is no synthesizer and the transcription tests skip.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const SPEECH_FILE = "out/speech.wav";

export const SPEECH_BEFORE =
	"The quick brown fox jumps over the lazy dog. Today we are testing a transcription tool that runs entirely in the web browser.";
export const SPEECH_AFTER =
	"After a long pause, the speaker continues. The password for the final project is written on the board.";

export function speechWav(file = SPEECH_FILE): boolean {
	if (fs.existsSync(file)) return true;
	if (process.platform !== "win32") return false;
	const script = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo 22050, ([System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen), ([System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile('${path.resolve(file).replaceAll("'", "''")}', $fmt)
$p = New-Object System.Speech.Synthesis.PromptBuilder
$p.AppendText('${SPEECH_BEFORE}')
$p.AppendBreak([TimeSpan]::FromSeconds(20))
$p.AppendText('${SPEECH_AFTER}')
$s.Speak($p)
$s.Dispose()`;
	try {
		execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore" });
		return fs.existsSync(file);
	} catch {
		return false;
	}
}
