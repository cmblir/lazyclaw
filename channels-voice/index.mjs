// @pompos/channel-voice
//
// v5.0 scope per spec §0.2: TRANSCRIBE-ONLY. No TTS reply (deferred to v5.1).
//
// This channel does not own its own transport. It registers itself with
// the Telegram and Discord plugins (and any other channel that exposes
// a `onVoiceMemo` hook) and acts as the transcription pipeline.
// Telegram/Discord call `voice.ingestVoiceMemo({threadId, audio, mime})`
// when a voice memo arrives; the resulting text is forwarded through
// this channel's handler and the text reply is sent on whichever channel
// the user is currently bound to via channels/threads.mjs.

import { Channel } from '../channels/base.mjs';

export class VoiceChannel extends Channel {
  constructor(opts = {}) {
    super('voice');
    this._transcribe = typeof opts.transcribe === 'function' ? opts.transcribe : null;
  }

  setTranscriber(fn) {
    if (typeof fn !== 'function') throw new Error('setTranscriber: function required');
    this._transcribe = fn;
  }

  async ingestVoiceMemo({ threadId, audio, mime }) {
    if (!this._transcribe) {
      const err = new Error('TRANSCRIBE_NOT_CONFIGURED');
      err.code = 'TRANSCRIBE_NOT_CONFIGURED';
      throw err;
    }
    if (!Buffer.isBuffer(audio)) {
      throw new Error('ingestVoiceMemo: audio must be a Buffer');
    }
    const text = await this._transcribe(audio, mime || 'audio/ogg');
    if (!text || typeof text !== 'string') return null;
    return await this._processInbound({
      threadId: String(threadId), text, gateInput: { token: 'voice' },
    });
  }

  // send() is intentionally a no-op text passthrough — voice channel does
  // not synthesise audio in v5.0. The text reply is delivered by whichever
  // channel the thread is bound to (channels/threads.mjs).
  async send(_threadId, _text) {
    // no-op
  }
}

/**
 * Default transcriber backed by an OpenAI-Whisper-compatible endpoint
 * (e.g. OpenAI /v1/audio/transcriptions or any compatible proxy). Used
 * by the registered factory when the host does not inject one.
 */
export function makeOpenAITranscriber({ apiKey, model = 'whisper-1', baseUrl = 'https://api.openai.com/v1' }) {
  if (!apiKey) throw new Error('makeOpenAITranscriber: apiKey required');
  return async function transcribe(audio, mime) {
    const fd = new FormData();
    const ext = (mime || '').split('/')[1] || 'ogg';
    fd.append('file', new Blob([audio], { type: mime || 'audio/ogg' }), `memo.${ext}`);
    fd.append('model', model);
    const res = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
    });
    if (!res.ok) throw new Error(`transcribe HTTP ${res.status}: ${await res.text()}`);
    const j = await res.json();
    return j.text || '';
  };
}

export function register({ addChannel }) {
  addChannel('voice', (opts) => {
    const ch = new VoiceChannel(opts || {});
    if (!opts?.transcribe && opts?.openai?.apiKey) {
      ch.setTranscriber(makeOpenAITranscriber(opts.openai));
    }
    return ch;
  });
}
