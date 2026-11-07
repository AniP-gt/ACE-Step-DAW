interface LogicTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, unknown>;
    readonly required: string[];
  };
}

const identifier = { type: 'string', minLength: 1 };
const session = { sessionId: identifier };

export const LOGIC_TOOLS: readonly LogicTool[] = [
  {
    name: 'logic_list_captures',
    description: 'List captures in an explicitly paired Logic bridge session.',
    inputSchema: { type: 'object', properties: session, required: ['sessionId'] },
  },
  {
    name: 'daw_attach_logic_capture',
    description: 'Attach an immutable Logic capture to its paired DAW project. Returns a ready reference binding.',
    inputSchema: {
      type: 'object',
      properties: { ...session, projectId: identifier, captureId: identifier, clientRequestId: identifier },
      required: ['sessionId', 'projectId', 'captureId', 'clientRequestId'],
    },
  },
  {
    name: 'daw_add_layer_from_context',
    description: 'Submit a Base Lego layer from an explicit Logic capture and frame range. Submission is not audio readiness; inspect the returned job.',
    inputSchema: {
      type: 'object',
      properties: {
        ...session, projectId: identifier, captureId: identifier, bindingId: identifier,
        clientRequestId: identifier, instrument: identifier, modelId: identifier,
        startFrame: { type: 'integer', minimum: 0 }, endFrame: { type: 'integer', minimum: 1 },
        prompt: { type: 'string' }, seed: { type: 'integer', minimum: 0 },
      },
      required: ['sessionId', 'projectId', 'captureId', 'bindingId', 'clientRequestId', 'instrument', 'modelId', 'startFrame', 'endFrame', 'prompt'],
    },
  },
  ...['logic_get_job', 'logic_cancel_job'].map(name => ({
    name,
    description: name === 'logic_get_job' ? 'Inspect persisted generation state and result readiness.' : 'Cancel a paired Logic generation job.',
    inputSchema: { type: 'object' as const, properties: { ...session, jobId: identifier }, required: ['sessionId', 'jobId'] },
  })),
  {
    name: 'logic_export_result',
    description: 'Get validated result metadata and owned WAV availability. Does not place a region in Logic.',
    inputSchema: { type: 'object', properties: { ...session, resultId: identifier }, required: ['sessionId', 'resultId'] },
  },
];
