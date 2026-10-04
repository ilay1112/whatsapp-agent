// V2-W1-11: the Change card line (UX2 3.3, 11.2, 14.1, 15.8; T2 5 "Renderer" + T2 9).
//   - en "Change: Wed 15:00 -> 17:00", he "שינוי: יום רביעי 15:00 ← 17:00";
//   - every side is its own <bdi>; the arrow is a muted aria-hidden TEXT glyph (U+2192 en / U+2190 he), never an icon;
//   - the visible line is aria-hidden, a visually hidden sibling carries the sentence;
//   - in he the DOM order is from - arrow - to and the computed direction is rtl;
//   - untrusted places / titles stay literal text inside their own <bdi>.
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ChangeView, EventContentView } from '@shared/types';
import { ChangeLine, ARROW_EN, ARROW_HE } from './ChangeLine';
import { i18next } from '../../../../tests/setup-renderer';

const ev = (patch: Partial<EventContentView> = {}): EventContentView => ({
  title: 'Meeting',
  startLocal: '2026-09-23T15:00:00',
  endLocal: '2026-09-23T16:00:00',
  timeZone: 'Asia/Jerusalem',
  location: 'Cafe Noir',
  status: 'confirmed',
  ...patch,
});
const change = (patch: Partial<ChangeView> = {}): ChangeView => ({
  kind: 'reschedule',
  from: ev(),
  to: ev({ startLocal: '2026-09-23T17:00:00', endLocal: '2026-09-23T18:00:00' }),
  confidence: 'high',
  baseRevision: 1,
  ...patch,
});

async function inHebrew(): Promise<void> {
  await i18next.changeLanguage('he');
  document.documentElement.dir = 'rtl';
  document.documentElement.lang = 'he';
}

describe('ChangeLine - reschedule', () => {
  it('en same day: "Change: Wed 15:00 -> 17:00" with a muted aria-hidden arrow glyph', () => {
    render(<ChangeLine change={change()} lang="en" />);
    const visible = screen.getByTestId('change-line-visible');
    expect(visible).toHaveTextContent(`Change: Wed 15:00 ${ARROW_EN} 17:00`);
    expect(visible).toHaveAttribute('aria-hidden', 'true');
    const arrow = screen.getByTestId('change-arrow');
    expect(arrow).toHaveTextContent('→');
    expect(arrow).toHaveAttribute('aria-hidden', 'true');
    expect(arrow).toHaveClass('change-arrow');
    expect(arrow.querySelector('svg, img')).toBeNull();
    expect(screen.getByTestId('change-line')).toHaveAttribute('data-kind', 'reschedule');
  });

  it('each side is its own <bdi>, old value first', () => {
    render(<ChangeLine change={change()} lang="en" />);
    const bdis = screen.getByTestId('change-line-visible').querySelectorAll('bdi');
    expect([...bdis].map((b) => b.textContent)).toEqual(['Wed 15:00', '17:00']);
  });

  it('exposes the full sentence to assistive technology', () => {
    render(<ChangeLine change={change()} lang="en" />);
    expect(screen.getByTestId('change-line-sentence')).toHaveTextContent('Change from Wednesday 15:00 to 17:00');
    expect(screen.getByTestId('change-line-sentence')).toHaveClass('sr-only');
  });

  it('en other day spells both days out', () => {
    render(
      <ChangeLine
        change={change({ to: ev({ startLocal: '2026-09-24T17:00:00', endLocal: '2026-09-24T18:00:00' }) })}
        lang="en"
      />,
    );
    const bdis = [...screen.getByTestId('change-line-visible').querySelectorAll('bdi')].map((b) => b.textContent);
    expect(bdis[0]).toMatch(/^Wed 23 Sep\w* 15:00$/);
    expect(bdis[1]).toMatch(/^Thu 24 Sep\w* 17:00$/);
  });

  it('he: "שינוי: יום רביעי 15:00 ← 17:00", DOM order from-arrow-to, direction rtl', async () => {
    await inHebrew();
    render(
      <div dir="rtl">
        <ChangeLine change={change()} lang="he" />
      </div>,
    );
    const visible = screen.getByTestId('change-line-visible');
    expect(visible).toHaveTextContent(`שינוי: יום רביעי 15:00 ${ARROW_HE} 17:00`);
    const nodes = [...visible.querySelectorAll('bdi, [data-testid="change-arrow"]')].map((n) => n.textContent);
    expect(nodes).toEqual(['יום רביעי 15:00', '←', '17:00']);
    expect(getComputedStyle(visible.closest('[dir]')!).direction).toBe('rtl');
    expect(screen.getByTestId('change-line-sentence')).toHaveTextContent('שינוי: 17:00 במקום יום רביעי 15:00');
  });

  it('he other day: "יום רביעי 23 בספט׳ 15:00 ← יום חמישי 24 בספט׳ 17:00"', async () => {
    await inHebrew();
    render(
      <ChangeLine
        change={change({ to: ev({ startLocal: '2026-09-24T17:00:00', endLocal: '2026-09-24T18:00:00' }) })}
        lang="he"
      />,
    );
    expect(screen.getByTestId('change-line-visible')).toHaveTextContent(
      'שינוי: יום רביעי 23 בספט׳ 15:00 ← יום חמישי 24 בספט׳ 17:00',
    );
  });

  it("'undo' (payload-only) reads like a reschedule", () => {
    render(<ChangeLine change={change({ kind: 'undo' })} lang="en" />);
    expect(screen.getByTestId('change-line')).toHaveAttribute('data-kind', 'reschedule');
  });
});

describe('ChangeLine - move and cancel', () => {
  it('move: "Place: Cafe Noir -> Office", the places are literal text in their own <bdi>', () => {
    render(<ChangeLine change={change({ kind: 'move', to: ev({ location: 'Office' }) })} lang="en" />);
    const visible = screen.getByTestId('change-line-visible');
    expect(visible).toHaveTextContent(`Place: Cafe Noir ${ARROW_EN} Office`);
    expect([...visible.querySelectorAll('bdi')].map((b) => b.textContent)).toEqual(['Cafe Noir', 'Office']);
    expect(screen.getByTestId('change-line-sentence')).toHaveTextContent('Place change from Cafe Noir to Office');
  });

  it('move with an empty place shows "-"', () => {
    render(
      <ChangeLine
        change={change({ kind: 'move', from: ev({ location: '' }), to: ev({ location: 'Office' }) })}
        lang="en"
      />,
    );
    expect(screen.getByTestId('change-line-visible')).toHaveTextContent(`Place: - ${ARROW_EN} Office`);
    expect(screen.getByTestId('change-line-sentence')).toHaveTextContent('Place change from - to Office');
  });

  it('cancel: "Cancel: Meeting, Wed 15:00" and no arrow', () => {
    render(<ChangeLine change={change({ kind: 'cancel' })} lang="en" />);
    const visible = screen.getByTestId('change-line-visible');
    expect(visible).toHaveTextContent('Cancel: Meeting, Wed 15:00');
    expect(screen.queryByTestId('change-arrow')).toBeNull();
    expect(screen.getByTestId('change-line-sentence')).toHaveTextContent('Cancel Meeting, Wed 15:00');
  });

  it('an untrusted title that looks like HTML stays literal text', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const { container } = render(
      <ChangeLine change={change({ kind: 'cancel', from: ev({ title: hostile }) })} lang="en" />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(within(screen.getByTestId('change-line-visible')).getByText(hostile)).toBeInTheDocument();
  });
});

describe('ChangeLine - RTL snapshots', () => {
  for (const kind of ['reschedule', 'move', 'cancel'] as const) {
    it(`he ${kind}`, async () => {
      await inHebrew();
      const { container } = render(
        <ChangeLine
          change={change({ kind, to: kind === 'move' ? ev({ location: 'Office' }) : change().to })}
          lang="he"
        />,
      );
      expect(container.firstChild).toMatchSnapshot();
    });
    it(`en ${kind}`, () => {
      const { container } = render(
        <ChangeLine
          change={change({ kind, to: kind === 'move' ? ev({ location: 'Office' }) : change().to })}
          lang="en"
        />,
      );
      expect(container.firstChild).toMatchSnapshot();
    });
  }
});
