export interface Word {
  type: 'word'
  attrs: {
    value: string
    startInSeconds: number
    duration: number
    videoSource: string
    audioSource: string
    audioStartInSeconds: number
  }
}
