import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { probePort, findFreePort, __setPortProbeRunner } from '../../../src/utils/port-probe';

describe('port-probe', () => {
  beforeEach(() => {
    __setPortProbeRunner(null);
  });

  afterEach(() => {
    __setPortProbeRunner(null);
  });

  describe('probePort', () => {
    it('returns {free: true} when lsof prints nothing', () => {
      __setPortProbeRunner(() => ({ status: 1, stdout: '' }));
      expect(probePort(3010)).toEqual({ free: true });
    });

    it('returns {free: false, holderPid} when lsof prints a pid', () => {
      __setPortProbeRunner(() => ({ status: 0, stdout: '54321\n' }));
      expect(probePort(3010)).toEqual({ free: false, holderPid: 54321 });
    });

    it('returns first pid when lsof prints multiple', () => {
      __setPortProbeRunner(() => ({ status: 0, stdout: '12345\n67890\n' }));
      expect(probePort(3010)).toEqual({ free: false, holderPid: 12345 });
    });

    it('treats unparseable lsof output as free and warns the operator', () => {
      __setPortProbeRunner(() => ({ status: 0, stdout: 'not-a-pid\n' }));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect(probePort(3010)).toEqual({ free: true });
        expect(warnSpy).toHaveBeenCalledOnce();
        expect(warnSpy.mock.calls[0][0]).toMatch(/could not parse lsof output for port 3010/);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('handles Buffer stdout', () => {
      __setPortProbeRunner(() => ({ status: 0, stdout: Buffer.from('99999\n') }));
      expect(probePort(3010)).toEqual({ free: false, holderPid: 99999 });
    });

    it('passes the right arguments to lsof', () => {
      let captured: { cmd: string; args: string[] } | null = null;
      __setPortProbeRunner((cmd, args) => {
        captured = { cmd, args };
        return { status: 1, stdout: '' };
      });
      probePort(4242);
      expect(captured).not.toBeNull();
      expect(captured!.cmd).toBe('lsof');
      expect(captured!.args).toEqual(['-tiTCP:4242', '-sTCP:LISTEN']);
    });
  });

  describe('findFreePort', () => {
    it('returns preferred when it is free', () => {
      __setPortProbeRunner(() => ({ status: 1, stdout: '' }));
      const result = findFreePort(3010, [3020, 3030]);
      expect(result).toEqual({ port: 3010, collisions: [] });
    });

    it('falls through to first available fallback when preferred is occupied', () => {
      const responses = [
        { status: 0, stdout: '111\n' },     // 3010 — occupied
        { status: 1, stdout: '' },          // 3020 — free
      ];
      let i = 0;
      __setPortProbeRunner(() => responses[i++]);
      const result = findFreePort(3010, [3020, 3030]);
      expect(result.port).toBe(3020);
      expect(result.collisions).toEqual([{ port: 3010, holderPid: 111 }]);
    });

    it('skips past multiple occupied fallbacks to the first free one', () => {
      const responses = [
        { status: 0, stdout: '111\n' },     // 3010
        { status: 0, stdout: '222\n' },     // 3020
        { status: 1, stdout: '' },          // 3030
      ];
      let i = 0;
      __setPortProbeRunner(() => responses[i++]);
      const result = findFreePort(3010, [3020, 3030]);
      expect(result.port).toBe(3030);
      expect(result.collisions).toEqual([
        { port: 3010, holderPid: 111 },
        { port: 3020, holderPid: 222 },
      ]);
    });

    it('throws with diagnostic message when every candidate is occupied', () => {
      const responses = [
        { status: 0, stdout: '111\n' },
        { status: 0, stdout: '222\n' },
        { status: 0, stdout: '333\n' },
      ];
      let i = 0;
      __setPortProbeRunner(() => responses[i++]);
      expect(() => findFreePort(3010, [3020, 3030])).toThrow(/All candidate ports occupied/);
      expect(() => {
        i = 0;
        findFreePort(3010, [3020, 3030]);
      }).toThrow(/3010=PID111/);
    });
  });
});
