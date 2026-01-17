/**
 * Sound effects using Web Audio API
 * No external audio files needed - generates sounds programmatically
 */

let audioContext: AudioContext | null = null

function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext()
  }
  return audioContext
}

// Play a simple tone
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

// Play a click sound (like marker cap)
export function playClick(): void {
  playTone(800, 0.05, 'square', 0.1)
}

// Play marker stroke start sound
export function playMarkerStart(): void {
  playTone(200, 0.1, 'sawtooth', 0.05)
}

// Play success chime (ascending notes)
export function playSuccess(): void {
  // Play three ascending notes
  const notes = [523.25, 659.25, 783.99] // C5, E5, G5
  notes.forEach((freq, i) => {
    setTimeout(() => playTone(freq, 0.15, 'sine', 0.2), i * 100)
  })
}

// Play error sound
export function playError(): void {
  playTone(200, 0.3, 'sawtooth', 0.15)
}

// Play level up / milestone sound
export function playLevelUp(): void {
  const notes = [392, 523.25, 659.25, 783.99] // G4, C5, E5, G5
  notes.forEach((freq, i) => {
    setTimeout(() => playTone(freq, 0.2, 'sine', 0.25), i * 80)
  })
}

// Paper rustle (white noise burst)
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

// Sound settings
let soundEnabled = true

export function setSoundEnabled(enabled: boolean): void {
  soundEnabled = enabled
  localStorage.setItem('doodle-sounds-enabled', String(enabled))
}

export function isSoundEnabled(): boolean {
  const stored = localStorage.getItem('doodle-sounds-enabled')
  if (stored !== null) {
    soundEnabled = stored === 'true'
  }
  return soundEnabled
}

// Wrapped versions that check if sound is enabled
export const sounds = {
  click: () => isSoundEnabled() && playClick(),
  markerStart: () => isSoundEnabled() && playMarkerStart(),
  success: () => isSoundEnabled() && playSuccess(),
  error: () => isSoundEnabled() && playError(),
  levelUp: () => isSoundEnabled() && playLevelUp(),
  paperRustle: () => isSoundEnabled() && playPaperRustle(),
}
