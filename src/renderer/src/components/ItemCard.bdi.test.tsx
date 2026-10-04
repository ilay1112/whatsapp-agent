// V2-W1-11: the shared `<bdi>` template renderer (UX 16.5). Untrusted values never touch the template: they are React
// children of their own <bdi>; `<bdi dir="ltr">` is honoured; a sentinel without a value renders an empty <bdi>.
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { SENTINEL, renderBdiTemplate } from './ItemCard.bdi';

describe('renderBdiTemplate', () => {
  it('wraps each interpolated value in its own <bdi>, keeping the literal text around it', () => {
    const { container } = render(
      <p>
        {renderBdiTemplate(`Sends to <bdi>${SENTINEL(0)}</bdi> at <bdi dir="ltr">${SENTINEL(1)}</bdi>.`, [
          'Dana',
          '+972',
        ])}
      </p>,
    );
    const bdis = container.querySelectorAll('bdi');
    expect([...bdis].map((b) => b.textContent)).toEqual(['Dana', '+972']);
    expect(bdis[0]).not.toHaveAttribute('dir');
    expect(bdis[1]).toHaveAttribute('dir', 'ltr');
    expect(container.textContent).toBe('Sends to Dana at +972.');
  });

  it('a bare sentinel (no markup) is still isolated; a missing value renders an empty <bdi>', () => {
    const { container } = render(<p>{renderBdiTemplate(`${SENTINEL(0)} and ${SENTINEL(3)}`, ['x'])}</p>);
    const bdis = container.querySelectorAll('bdi');
    expect(bdis).toHaveLength(2);
    expect(bdis[1]!.textContent).toBe('');
  });

  it('an untrusted value that looks like markup stays text', () => {
    const { container } = render(
      <p>{renderBdiTemplate(`<bdi>${SENTINEL(0)}</bdi>`, ['<img src=x onerror=alert(1)>'])}</p>,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('a template with no sentinel is returned as one text piece', () => {
    expect(renderBdiTemplate('plain', [])).toEqual(['plain']);
  });
});
