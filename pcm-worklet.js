// マイク音声を16 kHz・モノラル・16bit PCMへ変換し、約200 msごとにメインスレッドへ送る。
// AudioContextが16 kHzで開けない端末では、ここで線形補間により再サンプルする。
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = 16000;
    this.inputRate = sampleRate; // AudioWorkletGlobalScope の実サンプルレート
    this.ratio = this.inputRate / this.targetRate;
    this.chunkSamples = Math.round(this.targetRate * 0.2);
    this.buffer = new Int16Array(this.chunkSamples);
    this.filled = 0;
    this.phase = 0;
    this.prev = 0;
    this.peak = 0;
  }

  pushSample(value) {
    const clamped = Math.max(-1, Math.min(1, value));
    this.buffer[this.filled++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    const abs = Math.abs(clamped);
    if (abs > this.peak) this.peak = abs;
    if (this.filled >= this.chunkSamples) {
      this.port.postMessage({ pcm: this.buffer.buffer.slice(0), peak: this.peak });
      this.filled = 0;
      this.peak = 0;
    }
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    if (this.ratio === 1) {
      for (let i = 0; i < channel.length; i++) this.pushSample(channel[i]);
      return true;
    }
    // 再サンプル: 入力位置 phase を ratio ずつ進め、隣接2サンプルを線形補間する。
    let pos = this.phase;
    while (pos < channel.length) {
      const index = Math.floor(pos);
      const frac = pos - index;
      const a = index - 1 >= 0 ? channel[index - 1] : this.prev;
      const b = channel[index];
      this.pushSample(a + (b - a) * frac);
      pos += this.ratio;
    }
    this.phase = pos - channel.length;
    this.prev = channel[channel.length - 1];
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
