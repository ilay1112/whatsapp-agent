// ConsentDialog v2 - the two CLI kinds and the version-2 texts (UX2 7.5, 13; B21; owner V2-W1-12).
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  ANTIGRAVITY_TERMS_READ_ON,
  CLI_PROVIDER_IDS,
  API_KEY_PROVIDER_IDS,
  CONSENT_KIND_FOR,
  CONSENT_VERSIONS,
} from '@shared/types';
import { i18next } from '../../../../tests/setup-renderer';
import { ConsentDialog, cloudConsentKindOf, type CloudConsentKind } from './ConsentDialog';

const paint = (kind: CloudConsentKind, days?: number) =>
  render(
    <ConsentDialog
      kind={kind}
      version={CONSENT_VERSIONS[kind]}
      open
      days={days}
      onAccept={() => {}}
      onCancel={() => {}}
    />,
  );

describe('ConsentDialog v2', () => {
  it('cloudConsentKindOf maps every cloud provider to its kind', () => {
    expect(cloudConsentKindOf('claude')).toBe('cloud_claude');
    expect(cloudConsentKindOf('gemini')).toBe('cloud_gemini');
    expect(cloudConsentKindOf('claude_cli')).toBe('cloud_claude_cli');
    expect(cloudConsentKindOf('antigravity_cli')).toBe('cloud_antigravity_cli');
    for (const p of [...CLI_PROVIDER_IDS, ...API_KEY_PROVIDER_IDS])
      expect(cloudConsentKindOf(p)).toBe(CONSENT_KIND_FOR[p]);
  });

  it('cloud_claude v2 names voice transcripts and pictures; data-kind / data-version are the current constant', () => {
    paint('cloud_claude');
    const dialog = screen.getByTestId('consent-dialog');
    expect(dialog).toHaveAttribute('data-version', '2');
    expect(screen.getByTestId('consent-sent')).toHaveTextContent('transcripts of its voice notes');
    expect(screen.getByTestId('consent-accept')).toHaveTextContent('Send to Anthropic');
    expect(screen.queryByTestId('consent-good-to-know')).not.toBeInTheDocument();
    expect(screen.queryByTestId('consent-terms-date')).not.toBeInTheDocument();
  });

  it('cloud_claude_cli v1: "Good to know" and "Use my Claude subscription"', () => {
    paint('cloud_claude_cli');
    expect(screen.getByTestId('consent-dialog')).toHaveAttribute('data-kind', 'cloud_claude_cli');
    expect(screen.getByTestId('consent-good-to-know')).toHaveTextContent('under your own sign-in');
    expect(screen.getByTestId('consent-accept')).toHaveTextContent('Use my Claude subscription');
  });

  it('cloud_antigravity_cli v1: the last N days, never pictures, the full disclosure and the Terms read date', () => {
    paint('cloud_antigravity_cli', 14);
    expect(screen.getByTestId('consent-sent')).toHaveTextContent('the last 14 days of this chat');
    expect(screen.getByTestId('consent-sent')).toHaveTextContent('never pictures');
    expect(screen.getByTestId('consent-good-to-know')).toHaveTextContent('third-party software');
    const date = screen.getByTestId('consent-terms-date');
    expect(date).toHaveAttribute('data-date', ANTIGRAVITY_TERMS_READ_ON);
    expect(date).toHaveTextContent('Terms read on');
    expect(screen.getByTestId('consent-accept')).toHaveTextContent('I accept the risk - use Gemini');
  });

  it('Hebrew copy of the CLI kinds', async () => {
    await i18next.changeLanguage('he');
    paint('cloud_antigravity_cli');
    expect(screen.getByTestId('consent-terms-date').querySelector('bdi')).not.toBeNull();
    expect(screen.getByRole('heading', { level: 2 }).textContent).not.toBe('');
  });
});
