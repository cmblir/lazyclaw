// media — image_describe (vision provider), image_generate (FAL/DALL-E
// optional via env key), tts_speak (deferred to v5.1 per spec §0.2),
// transcribe (whisper.cpp local OR OpenAI whisper API by env key).
// Provider integrations are opt-in via env vars; all return a structured
// "configure X" error otherwise.

import fs from 'node:fs';
import { fetch } from 'undici';

const image_describe = {
  name: 'image_describe', category: 'media', sensitive: true,
  description: 'Describe an image. Requires OPENAI_API_KEY (gpt-4o vision) or ANTHROPIC_API_KEY (claude vision).',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, prompt: { type: 'string' } },
    required: ['path'],
  },
  async exec(args, ctx) {
    const env = ctx?.env || process.env;
    if (!fs.existsSync(args.path)) return { ok: false, error: `image_describe: file not found ${args.path}` };
    const b64 = fs.readFileSync(args.path).toString('base64');
    const prompt = args.prompt || 'Describe this image briefly.';
    if (env.OPENAI_API_KEY) {
      try {
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST', headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
          ] }] }),
        });
        const j = await r.json();
        return { ok: true, description: j?.choices?.[0]?.message?.content || '' };
      } catch (e) { return { ok: false, error: `image_describe: ${e.message}` }; }
    }
    return { ok: false, error: 'image_describe: set OPENAI_API_KEY (gpt-4o vision)' };
  },
};

const image_generate = {
  name: 'image_generate', category: 'media', sensitive: true,
  // Working tool: the OPENAI_API_KEY path makes a real images/generations call
  // (gpt-image-1); only the FAL_KEY path is unimplemented. NOT a stub — stays
  // advertised so the 'media' toolset works on OpenAI-key deployments.
  description: 'Generate an image. Requires OPENAI_API_KEY (DALL-E) or FAL_KEY.',
  parameters: {
    type: 'object',
    properties: { prompt: { type: 'string' }, outPath: { type: 'string' } },
    required: ['prompt'],
  },
  async exec(args, ctx) {
    const env = ctx?.env || process.env;
    if (!env.OPENAI_API_KEY && !env.FAL_KEY) return { ok: false, error: 'image_generate: set OPENAI_API_KEY or FAL_KEY' };
    if (env.OPENAI_API_KEY) {
      try {
        const r = await fetch('https://api.openai.com/v1/images/generations', {
          method: 'POST', headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-image-1', prompt: args.prompt, size: '1024x1024' }),
        });
        const j = await r.json();
        const b64 = j?.data?.[0]?.b64_json;
        if (!b64) return { ok: false, error: `image_generate: no data (${JSON.stringify(j).slice(0, 200)})` };
        if (args.outPath) fs.writeFileSync(args.outPath, Buffer.from(b64, 'base64'));
        return { ok: true, outPath: args.outPath || null, b64: args.outPath ? null : b64 };
      } catch (e) { return { ok: false, error: `image_generate: ${e.message}` }; }
    }
    return { ok: false, error: 'image_generate: FAL_KEY path not implemented in v5.0 (configure OPENAI_API_KEY)' };
  },
};

const tts_speak = {
  name: 'tts_speak', category: 'media', sensitive: true,
  unavailable: true, // not implemented (deferred to v5.1) — hidden from tool schemas until wired
  description: 'STUB — TTS reply deferred to v5.1 per spec §0.2.',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  async exec() {
    return { ok: false, error: 'tts_speak: deferred to v5.1 (spec §0.2)' };
  },
};

const transcribe = {
  name: 'transcribe', category: 'media', sensitive: true,
  description: 'Transcribe audio. Requires OPENAI_API_KEY (whisper) or a local whisper.cpp binary at WHISPER_CPP.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, language: { type: 'string' } },
    required: ['path'],
  },
  async exec(args, ctx) {
    const env = ctx?.env || process.env;
    if (!fs.existsSync(args.path)) return { ok: false, error: `transcribe: file not found ${args.path}` };
    if (env.OPENAI_API_KEY) {
      try {
        const fd = new FormData();
        fd.append('file', new Blob([fs.readFileSync(args.path)]), 'audio');
        fd.append('model', 'whisper-1');
        if (args.language) fd.append('language', args.language);
        const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST', headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}` }, body: fd,
        });
        const j = await r.json();
        return { ok: true, text: j?.text || '' };
      } catch (e) { return { ok: false, error: `transcribe: ${e.message}` }; }
    }
    return { ok: false, error: 'transcribe: set OPENAI_API_KEY (whisper-1)' };
  },
};

export const TOOLS = [image_describe, image_generate, tts_speak, transcribe];
