// JSON log lines on stderr: stdout belongs to MCP over stdio.

export type Logger = (fields: Record<string, unknown>) => void;

export const log: Logger = (fields) => {
  process.stderr.write(
    `${JSON.stringify({ time: new Date().toISOString(), ...fields })}\n`,
  );
};
