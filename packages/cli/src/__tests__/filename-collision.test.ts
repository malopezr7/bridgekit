import { resolveContractNames } from '../emit/assemble.js';

describe('contract filename collision resolution', () => {
  it('suffixes every member of a normalized class-name collision group with stable hash8 ids', () => {
    const first = resolveContractNames(['demo.x-y', 'demo.x.y']);
    const second = resolveContractNames(['demo.x.y', 'demo.x-y']);

    expect(first.get('demo.x-y')).toMatch(/^DemoXY_[a-f0-9]{8}$/);
    expect(first.get('demo.x.y')).toMatch(/^DemoXY_[a-f0-9]{8}$/);
    expect(first.get('demo.x-y')).not.toBe(first.get('demo.x.y'));
    expect(first.get('demo.x-y')).toBe(second.get('demo.x-y'));
    expect(first.get('demo.x.y')).toBe(second.get('demo.x.y'));
  });

  it('leaves non-colliding normalized class names unchanged', () => {
    const names = resolveContractNames(['demo.alpha', 'demo.beta']);

    expect(names.get('demo.alpha')).toBe('DemoAlpha');
    expect(names.get('demo.beta')).toBe('DemoBeta');
  });

  it('fails safely when hash-suffixed collision names still collide', () => {
    expect(() => resolveContractNames(['demo.x-y', 'demo.x.y'], () => 'deadbeef')).toThrow(
      /demo\.x-y.*demo\.x\.y|demo\.x\.y.*demo\.x-y/,
    );
  });
});
