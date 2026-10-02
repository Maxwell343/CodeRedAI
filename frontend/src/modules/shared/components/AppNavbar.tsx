import { useEffect, useRef, type MouseEvent } from 'react';

import { grantAdminAuthUnlock } from '@/utils/redirectByRole';
import { triggerEmergencyDeactivatedNotice } from './EmergencyDeactivatedModal';
import './AppNavbar.css';

const ADMIN_BRAND_TAP_TARGET = 5;
const ADMIN_BRAND_TAP_RESET_MS = 8000;

export function AppNavbar() {
  const brandTapCountRef = useRef(0);
  const brandTapResetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (brandTapResetTimerRef.current !== null) {
        window.clearTimeout(brandTapResetTimerRef.current);
      }
    };
  }, []);

  const resetBrandTapSequence = () => {
    brandTapCountRef.current = 0;

    if (brandTapResetTimerRef.current !== null) {
      window.clearTimeout(brandTapResetTimerRef.current);
      brandTapResetTimerRef.current = null;
    }
  };

  const handleBrandClick = (event: MouseEvent<HTMLAnchorElement>) => {
    brandTapCountRef.current += 1;

    if (brandTapResetTimerRef.current !== null) {
      window.clearTimeout(brandTapResetTimerRef.current);
      brandTapResetTimerRef.current = null;
    }

    if (brandTapCountRef.current >= ADMIN_BRAND_TAP_TARGET) {
      event.preventDefault();
      grantAdminAuthUnlock();
      resetBrandTapSequence();
      window.location.hash = '/admin/auth';
      return;
    }

    brandTapResetTimerRef.current = window.setTimeout(() => {
      brandTapCountRef.current = 0;
      brandTapResetTimerRef.current = null;
    }, ADMIN_BRAND_TAP_RESET_MS);
  };

  return (
    <header className="app-navbar-shell">
      <div className="app-navbar">
        <a href="#/" className="app-navbar-brand" aria-label="CodeRed home" onClick={handleBrandClick}>
          <span className="app-navbar-brand-mark" aria-hidden="true">
            <span className="app-navbar-brand-bar app-navbar-brand-bar-horizontal" />
            <span className="app-navbar-brand-bar app-navbar-brand-bar-vertical" />
          </span>
          <span className="app-navbar-brand-copy">
            Code<span>Red</span>
          </span>
        </a>

        <div className="app-navbar-actions">
          <a className="app-navbar-auth" href="#/auth">
            Join Us
          </a>

          <button
            type="button"
            className="app-navbar-emergency"
            onClick={triggerEmergencyDeactivatedNotice}
            aria-label="Send Help Now"
          >
            <svg className="app-navbar-emergency-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z" />
              <path d="M12 0C5.373 0 0 5.373 0 12c0 2.123.555 4.116 1.529 5.845L0 24l6.335-1.51A11.946 11.946 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.8 9.8 0 01-5.012-1.374l-.36-.213-3.76.896.957-3.665-.234-.376A9.818 9.818 0 012.182 12C2.182 6.57 6.57 2.182 12 2.182S21.818 6.57 21.818 12 17.43 21.818 12 21.818z" />
            </svg>
            SEND HELP NOW
          </button>
        </div>
      </div>
    </header>
  );
}