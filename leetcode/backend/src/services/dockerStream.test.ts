import { describe, it, expect } from 'vitest';
import { DockerStreamDemuxer, encodeDockerFrame } from './dockerStream.js';

const LIMITS = { stdoutBytes: 1024, stderrBytes: 1024 };

describe('DockerStreamDemuxer', () => {
  it('strips frame headers and separates stdout from stderr', () => {
    const demux = new DockerStreamDemuxer(LIMITS);
    demux.push(Buffer.concat([
      encodeDockerFrame('stdout', '[0,'),
      encodeDockerFrame('stderr', 'DeprecationWarning: x\n'),
      encodeDockerFrame('stdout', '1]\n'),
    ]));

    expect(demux.stdout).toBe('[0,1]\n');
    expect(demux.stderr).toBe('DeprecationWarning: x\n');
  });

  it('handles headers and payloads split across arbitrary chunk boundaries', () => {
    const wire = Buffer.concat([
      encodeDockerFrame('stdout', 'hello '),
      encodeDockerFrame('stdout', 'world\n'),
      encodeDockerFrame('stderr', 'oops'),
    ]);
    const demux = new DockerStreamDemuxer(LIMITS);
    // Feed one byte at a time: the worst case for a parser that assumes aligned chunks.
    for (const byte of wire) demux.push(Buffer.from([byte]));

    expect(demux.stdout).toBe('hello world\n');
    expect(demux.stderr).toBe('oops');
  });

  it('keeps multi-byte characters intact when a frame splits them', () => {
    const text = Buffer.from('héllo ✓', 'utf8');
    const demux = new DockerStreamDemuxer(LIMITS);
    demux.push(encodeDockerFrame('stdout', text.subarray(0, 2)));
    demux.push(encodeDockerFrame('stdout', text.subarray(2)));

    expect(demux.stdout).toBe('héllo ✓');
  });

  it('accepts empty frames', () => {
    const demux = new DockerStreamDemuxer(LIMITS);
    demux.push(Buffer.concat([encodeDockerFrame('stdout', ''), encodeDockerFrame('stdout', '42')]));
    expect(demux.stdout).toBe('42');
  });

  it('caps stdout and reports the overflow', () => {
    const demux = new DockerStreamDemuxer({ stdoutBytes: 10, stderrBytes: 10 });
    demux.push(encodeDockerFrame('stdout', '0123456789ABCDEF'));

    expect(demux.stdout).toBe('0123456789');
    expect(demux.stdoutLimitExceeded).toBe(true);
  });

  it('truncates stderr without flagging an output-limit verdict', () => {
    const demux = new DockerStreamDemuxer({ stdoutBytes: 10, stderrBytes: 4 });
    demux.push(encodeDockerFrame('stderr', 'Traceback (most recent call last)'));

    expect(demux.stderr).toBe('Trac');
    expect(demux.stdoutLimitExceeded).toBe(false);
  });
});
