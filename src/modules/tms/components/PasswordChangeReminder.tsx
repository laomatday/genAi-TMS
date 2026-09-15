import { useCallback, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import ConfirmDialog from '@/shared/components/modals/ConfirmDialog';
import { getDeviceActivation, subscribeDeviceActivation } from '@/core/deviceActivation';
import { scopedStorageKey } from '@/shared/constants';
import type { Employee } from '@/shared/types';

const DISMISSED_KEY = 'genai_password_reminder_dismissed';

/** Kept per device rather than per session: this is a one-time nudge at setup,
 *  not a standing reminder, and an employee who chose to keep the issued
 *  password should not be asked again on every sign-in. Every access is guarded
 *  because restricted and private browsing modes throw on the getter itself,
 *  and a reminder must never break the screen behind it. */
function readDismissed(key: string) {
  try {
    return globalThis.localStorage?.getItem(key) === '1';
  } catch {
    return false;
  }
}

function storeDismissed(key: string) {
  try {
    globalThis.localStorage?.setItem(key, '1');
  } catch {
    // The prompt still closes for this render; only the memory of it is lost.
  }
}

interface Props {
  user: Employee;
  /** Route that opens the profile password form, or null when this account has
   *  no screen to send the employee to. The prompt then only informs. */
  profilePath: string | null;
}

/** Prompts an employee whose account still carries the default password issued
 *  at provisioning. It is deliberately dismissible — it informs rather than
 *  gates, so it never stands between someone and a check-in.
 *
 *  It belongs to first setup, so it is shown only while the account has no
 *  trusted device bound on this browser. Once the device is activated the
 *  employee has been through the setup they were going to go through, and an
 *  account that stays on its issued password is then a matter for the admin
 *  report, not for a dialog on every sign-in. */
const PasswordChangeReminder = ({ user, profilePath }: Props) => {
  const navigate = useNavigate();
  const dismissedKey = scopedStorageKey(DISMISSED_KEY, user);
  const [dismissed, setDismissed] = useState(() => readDismissed(dismissedKey));
  const activation = useSyncExternalStore(subscribeDeviceActivation, getDeviceActivation);

  const dismiss = useCallback(() => {
    storeDismissed(dismissedKey);
    setDismissed(true);
  }, [dismissedKey]);

  const openPasswordForm = useCallback(() => {
    dismiss();
    if (profilePath) navigate(`${profilePath}?tab=profile&modal=profile-password`);
  }, [dismiss, navigate, profilePath]);

  // Kiosk stations are shared hardware signed in by an operator, so there is no
  // individual owner to prompt. 'unknown' covers both the moment before the
  // device status lands and an account held at the device gate, neither of
  // which should have a dialog laid over it.
  if (dismissed || user.role === 'Kiosk' || !user.password_change_required) return null;
  if (activation !== 'unbound') return null;

  return (
    <ConfirmDialog
      isOpen
      type="warning"
      title="Hãy đổi mật khẩu"
      message={
        <>
          {/* The flag is also raised for accounts that were never reset, so this
              must not assert that the reader is still on the default password —
              it states why the default is weak and lets them judge. */}
          Mật khẩu mặc định cấp khi khởi tạo được tạo theo họ tên, nên người khác có thể đoán ra.
          Nếu bạn chưa từng đổi, hãy đặt mật khẩu riêng ngay.
          {profilePath ? ' Chỉ mất một phút và bảo vệ được dữ liệu chấm công của bạn.' : ' Liên hệ quản trị viên để được hỗ trợ.'}
        </>
      }
      confirmLabel={profilePath ? 'Đổi mật khẩu' : 'Đã hiểu'}
      cancelLabel={profilePath ? 'Để sau' : ''}
      onConfirm={openPasswordForm}
      onCancel={dismiss}
    />
  );
};

export default PasswordChangeReminder;
