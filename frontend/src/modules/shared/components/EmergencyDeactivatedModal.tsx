import { useEffect, useState } from 'react';
import { AlertCircle, X } from 'lucide-react';
import './EmergencyDeactivatedModal.css';

export const EMERGENCY_DEACTIVATED_EVENT = 'codered:emergency-deactivated';

export function triggerEmergencyDeactivatedNotice() {
  window.dispatchEvent(new CustomEvent(EMERGENCY_DEACTIVATED_EVENT));
}

export function EmergencyDeactivatedModal() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let timer: number | null = null;

    const handleOpen = () => {
      // Re-trigger animation cleanly if clicked again
      setVisible(false);
      setTimeout(() => {
        setVisible(true);
      }, 50);

      if (timer) clearTimeout(timer);
      timer = window.setTimeout(() => {
        setVisible(false);
      }, 4500);
    };

    window.addEventListener(EMERGENCY_DEACTIVATED_EVENT, handleOpen);
    return () => {
      window.removeEventListener(EMERGENCY_DEACTIVATED_EVENT, handleOpen);
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!visible) return null;

  return (
    <div className="emergency-toast-container" role="status" aria-live="polite">
      <div className="emergency-toast">
        <div className="emergency-toast-icon">
          <AlertCircle size={20} />
        </div>

        <div className="emergency-toast-content">
          <p className="emergency-toast-message">
            WhatsApp emergency help feature is currently deactivated by admin
          </p>
        </div>

        <button
          type="button"
          className="emergency-toast-close"
          onClick={() => setVisible(false)}
          aria-label="Dismiss notification"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
