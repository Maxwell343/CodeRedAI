import { useEffect, useState } from 'react';
import { AlertTriangle, PhoneCall, X, ShieldAlert } from 'lucide-react';
import './EmergencyDeactivatedModal.css';

export const EMERGENCY_DEACTIVATED_EVENT = 'codered:emergency-deactivated';

export function triggerEmergencyDeactivatedNotice() {
  window.dispatchEvent(new CustomEvent(EMERGENCY_DEACTIVATED_EVENT));
}

export function EmergencyDeactivatedModal() {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const handleOpen = () => setIsOpen(true);
    window.addEventListener(EMERGENCY_DEACTIVATED_EVENT, handleOpen);
    return () => window.removeEventListener(EMERGENCY_DEACTIVATED_EVENT, handleOpen);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      className="emergency-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="emergency-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) setIsOpen(false);
      }}
    >
      <div className="emergency-modal-card">
        <button
          type="button"
          className="emergency-modal-close"
          onClick={() => setIsOpen(false)}
          aria-label="Close notice"
        >
          <X size={18} />
        </button>

        <div className="emergency-modal-header">
          <div className="emergency-modal-icon-badge">
            <ShieldAlert size={26} />
          </div>
          <span className="emergency-modal-tag">Service Notice</span>
          <h2 id="emergency-modal-title" className="emergency-modal-title">
            WhatsApp Emergency Feature Deactivated
          </h2>
        </div>

        <div className="emergency-modal-body">
          <p className="emergency-modal-desc">
            The <strong>WhatsApp Help Emergency</strong> dispatch feature is currently <strong>deactivated by the administrator</strong>.
          </p>

          <div className="emergency-modal-alert-box">
            <div className="emergency-modal-alert-icon">
              <AlertTriangle size={18} />
            </div>
            <div className="emergency-modal-alert-text">
              <strong>Need Urgent Medical Assistance?</strong>
              <p>Please call standard emergency hotlines immediately:</p>
            </div>
          </div>

          <div className="emergency-modal-contacts">
            <a href="tel:112" className="emergency-contact-btn">
              <PhoneCall size={16} />
              <span>Call <strong>112</strong> (National Emergency)</span>
            </a>
            <a href="tel:108" className="emergency-contact-btn">
              <PhoneCall size={16} />
              <span>Call <strong>108</strong> (Ambulance Helpline)</span>
            </a>
          </div>
        </div>

        <div className="emergency-modal-footer">
          <button
            type="button"
            className="emergency-modal-btn-dismiss"
            onClick={() => setIsOpen(false)}
          >
            Understood
          </button>
        </div>
      </div>
    </div>
  );
}
