/**
 * Sound effects module using Web Audio API.
 * Provides synthesized sound effects for the drawing game UI feedback.
 * No external audio files needed - all sounds are generated programmatically.
 * @module utils/sounds
 */

/** Web Audio context - created lazily on first sound */
let audioContext: AudioContext | null = null

/**
 * Gets or creates the Web Audio context.
 * Creates lazily because AudioContext requires user gesture in modern browsers.
 *
 * @returns The shared AudioContext instance
 */
function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext()
  }
  return audioContext
}

/**
 * Plays a simple tone with the given parameters.
 * Uses an oscillator with exponential decay envelope.
 *
 * @param frequency - Tone frequency in Hz
 * @param duration - Duration in seconds
 * @param type - Oscillator waveform type (sine, square, sawtooth, triangle)
 * @param volume - Volume from 0 to 1 (default 0.3)
 */
function playTone(
  frequency: number,
  duration: number,
  type: OscillatorType = 'sine',
  volume = 0.3
): void {
  try {
    const ctx = getAudioContext()
    const oscillator = ctx.createOscillator()
    const gainNode = ctx.createGain()

    oscillator.connect(gainNode)
    gainNode.connect(ctx.destination)

    oscillator.type = type
    oscillator.frequency.setValueAtTime(frequency, ctx.currentTime)

    // Fade out
    gainNode.gain.setValueAtTime(volume, ctx.currentTime)
    gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration)

    oscillator.start(ctx.currentTime)
    oscillator.stop(ctx.currentTime + duration)
  } catch (e) {
    // Audio might not be available
    console.log('Audio not available:', e)
  }
}

/**
 * Plays a short click sound like a marker cap.
 */
export function playClick(): void {
  playTone(800, 0.05, 'square', 0.1)
}

/**
 * Plays a subtle sound when starting a stroke.
 */
export function playMarkerStart(): void {
  playTone(200, 0.1, 'sawtooth', 0.05)
}

/**
 * Plays a success chime with ascending notes (C5, E5, G5).
 * Used when a drawing is successfully submitted.
 */
export function playSuccess(): void {
  // Play three ascending notes
  const notes = [523.25, 659.25, 783.99] // C5, E5, G5
  notes.forEach((freq, i) => {
    setTimeout(() => playTone(freq, 0.15, 'sine', 0.2), i * 100)
  })
}

/**
 * Plays a low descending error sound.
 * Used when an action fails.
 */
export function playError(): void {
  playTone(200, 0.3, 'sawtooth', 0.15)
}

/**
 * Plays a celebratory arpeggio (G4, C5, E5, G5).
 * Used for level ups and milestones.
 */
export function playLevelUp(): void {
  const notes = [392, 523.25, 659.25, 783.99] // G4, C5, E5, G5
  notes.forEach((freq, i) => {
    setTimeout(() => playTone(freq, 0.2, 'sine', 0.25), i * 80)
  })
}

/**
 * Plays a white noise burst simulating paper rustling.
 * Uses a buffer source with high-pass filter.
 */
export function playPaperRustle(): void {
  try {
    const ctx = getAudioContext()
    const bufferSize = ctx.sampleRate * 0.1 // 100ms
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate)
    const data = buffer.getChannelData(0)

    // Generate white noise
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * 0.1
    }

    const source = ctx.createBufferSource()
    const gainNode = ctx.createGain()
    const filter = ctx.createBiquadFilter()

    source.buffer = buffer
    filter.type = 'highpass'
    filter.frequency.value = 1000

    source.connect(filter)
    filter.connect(gainNode)
    gainNode.connect(ctx.destination)

    gainNode.gain.setValueAtTime(0.1, ctx.currentTime)
    gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1)

    source.start()
  } catch (e) {
    console.log('Audio not available:', e)
  }
}

/** Whether sounds are currently enabled */
let soundEnabled = true

/**
 * Enables or disables sound effects.
 * Persists the preference to localStorage.
 *
 * @param enabled - Whether sounds should be enabled
 */
export function setSoundEnabled(enabled: boolean): void {
  soundEnabled = enabled
  localStorage.setItem('doodle-sounds-enabled', String(enabled))
}

/**
 * Checks if sounds are currently enabled.
 * Reads from localStorage on first call.
 *
 * @returns True if sounds are enabled
 */
export function isSoundEnabled(): boolean {
  const stored = localStorage.getItem('doodle-sounds-enabled')
  if (stored !== null) {
    soundEnabled = stored === 'true'
  }
  return soundEnabled
}

/**
 * Sound effect functions that respect the global enabled/disabled setting.
 * Call these instead of the individual play functions directly.
 */
export const sounds = {
  /** Short click for button presses */
  click: () => isSoundEnabled() && playClick(),
  /** Subtle sound when starting a stroke */
  markerStart: () => isSoundEnabled() && playMarkerStart(),
  /** Ascending chime for successful actions */
  success: () => isSoundEnabled() && playSuccess(),
  /** Low tone for errors */
  error: () => isSoundEnabled() && playError(),
  /** Celebratory arpeggio for milestones */
  levelUp: () => isSoundEnabled() && playLevelUp(),
  /** White noise burst for paper effects */
  paperRustle: () => isSoundEnabled() && playPaperRustle(),
}
