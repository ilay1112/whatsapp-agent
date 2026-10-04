// V2-W1-11: "the contact, as the app read the picture" (UX2 1.1, 3.6, 11.6, 15.3; B19, B27; T2 5 "Renderer").
//   - readText / as-written values are inert text (dir="auto"; `<img onerror>` and markdown links stay literal);
//   - the thumbnail shows ONLY an inline base64 raster data URL (never http:, file:, javascript:, svg);
//   - the picture is not a link, not draggable, not focusable; alt = "Picture sent by {name}".
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ImageReadView } from '@shared/types';
import { ImageBubble, InertPicture, safeImageSrc } from './ImageBubble';
import { i18next } from '../../../../tests/setup-renderer';

const JPEG =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
const image = (patch: Partial<ImageReadView> = {}): ImageReadView => ({
  thumbDataUrl: JPEG,
  readText: "Dana & Yossi's wedding · Thursday 24.9.26 · reception 19:00",
  dateText: '24.9.26',
  timeText: '19:00',
  location: 'Gan Oranim',
  confidence: 'high',
  kind: 'invitation',
  ...patch,
});

describe('safeImageSrc', () => {
  it('accepts only inline base64 jpeg / png / webp', () => {
    expect(safeImageSrc(JPEG)).toBe(JPEG);
    expect(safeImageSrc('data:image/png;base64,iVBORw0KGgo=')).not.toBeNull();
    expect(safeImageSrc('data:image/webp;base64,UklGRg==')).not.toBeNull();
    for (const bad of [
      'http://evil.example/x.jpg',
      'https://evil.example/x.jpg',
      'file:///C:/x.jpg',
      'javascript:alert(1)',
      'data:image/svg+xml;base64,PHN2Zz4=',
      'data:text/html;base64,PGh0bWw+',
      'data:image/jpeg;base64,abc"onerror="x',
      '',
      null,
      undefined,
    ])
      expect(safeImageSrc(bad)).toBeNull();
  });
});

describe('ImageBubble - card', () => {
  it('header, dotted rule, 96 px thumbnail, read text, caution line', () => {
    render(<ImageBubble image={image()} contactName="Dana" mode="card" />);
    const bubble = screen.getByTestId('image-bubble');
    expect(bubble).toHaveTextContent('Picture');
    expect(bubble.querySelector('.media-rule')).not.toBeNull();
    const thumb = screen.getByTestId('image-thumb');
    expect(thumb).toHaveAttribute('src', JPEG);
    expect(thumb).toHaveAttribute('alt', 'Picture sent by Dana');
    expect(thumb).toHaveAttribute('draggable', 'false');
    expect(thumb).toHaveClass('image-thumb');
    expect(thumb.closest('a')).toBeNull();
    expect(thumb).not.toHaveAttribute('tabindex');
    expect(screen.getByTestId('image-readtext')).toHaveAttribute('dir', 'auto');
    expect(screen.getByTestId('image-readtext').style.webkitLineClamp).toBe('3');
    expect(screen.getByTestId('image-caution')).toHaveTextContent('Read from the picture - may contain mistakes');
    expect(screen.queryByTestId('image-as-written')).toBeNull();
  });

  it('an http thumbnail is never displayed', () => {
    const { container } = render(
      <ImageBubble image={image({ thumbDataUrl: 'https://evil.example/pixel.gif' })} contactName="Dana" mode="card" />,
    );
    expect(container.querySelector('img')).toBeNull();
  });

  it('read text is inert: HTML / markdown stay literal, no <a>, no extra <img>', () => {
    const hostile = '<img src=x onerror=alert(1)> [rsvp](http://evil.example)';
    const { container } = render(
      <ImageBubble image={image({ readText: hostile, thumbDataUrl: null })} contactName="<b>x</b>" mode="card" />,
    );
    expect(screen.getByTestId('image-readtext').textContent).toBe(hostile);
    expect(container.querySelector('a, img, b')).toBeNull();
  });

  it('the contact name reaches only the alt attribute, as plain text', () => {
    render(<ImageBubble image={image()} contactName={'"><script>x</script>'} mode="card" />);
    expect(screen.getByTestId('image-thumb')).toHaveAttribute('alt', 'Picture sent by "><script>x</script>');
    expect(document.querySelector('script')).toBeNull();
  });

  it('no read text: only the header and the caution', () => {
    render(<ImageBubble image={image({ readText: '' })} contactName="Dana" mode="card" />);
    expect(screen.queryByTestId('image-readtext')).toBeNull();
  });

  it('the context menu is suppressed on the picture', () => {
    render(<InertPicture src={JPEG} alt="a" className="c" testId="p" />);
    const prevented = !fireEvent.contextMenu(screen.getByTestId('p'));
    expect(prevented).toBe(true);
  });
});

describe('ImageBubble - sheet', () => {
  it('no thumbnail (the sheet shows the picture itself), the three as-written lines with "-" for empty values', () => {
    render(<ImageBubble image={image({ location: '' })} contactName="Dana" mode="sheet" />);
    expect(screen.queryByTestId('image-thumb')).toBeNull();
    expect(screen.getByTestId('image-readtext').style.webkitLineClamp).toBe('');
    expect(screen.getByTestId('sheet-as-written-date')).toHaveTextContent('Date as written: 24.9.26');
    expect(screen.getByTestId('sheet-as-written-time')).toHaveTextContent('Time as written: 19:00');
    expect(screen.getByTestId('sheet-as-written-place')).toHaveTextContent('Place as written: -');
    expect(screen.getByTestId('sheet-as-written-date').querySelector('bdi')).toHaveTextContent('24.9.26');
  });

  it('RTL snapshot (he)', async () => {
    await i18next.changeLanguage('he');
    document.documentElement.dir = 'rtl';
    const { container } = render(<ImageBubble image={image()} contactName="דנה" mode="card" />);
    expect(screen.getByTestId('image-thumb')).toHaveAttribute('alt', 'תמונה שנשלחה על ידי דנה');
    expect(container.firstChild).toMatchSnapshot();
  });
});
