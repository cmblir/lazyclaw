// Home Assistant tools — STUB only in v5.0; activated in v5.1 per spec §0.2.
// Registered so the catalogue lists them and config / toolset definitions
// can reference them, but exec() returns a clear deferred message.

function deferred(name) {
  return async () => ({ ok: false, error: `${name}: Home Assistant tools deferred to v5.1 (spec §0.2)` });
}

const ha_call_service = {
  name: 'ha_call_service', category: 'iot', sensitive: true,
  description: 'STUB — Home Assistant service call deferred to v5.1.',
  parameters: {
    type: 'object',
    properties: {
      domain: { type: 'string' }, service: { type: 'string' },
      data: { type: 'object' },
    },
    required: ['domain', 'service'],
  },
  exec: deferred('ha_call_service'),
};

const ha_get_state = {
  name: 'ha_get_state', category: 'iot', sensitive: true,
  description: 'STUB — Home Assistant state read deferred to v5.1.',
  parameters: {
    type: 'object',
    properties: { entity_id: { type: 'string' } },
    required: ['entity_id'],
  },
  exec: deferred('ha_get_state'),
};

export const TOOLS = [ha_call_service, ha_get_state];
