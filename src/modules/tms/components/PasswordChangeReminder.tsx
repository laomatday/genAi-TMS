import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ConfirmDialog from '@/shared/components/modals/ConfirmDialog';
import { scopedStorageKey } from '@/shared/constants';
import type { Employee } from '@/shared/types';

const DISMISSED_KEY = 'genai_password_reminder_dismissed';

/** Session scoped on purpose: dismissing the prompt silences it for the rest of
 *  this sign-in, and it returns the next time the employee logs in. Every access
 *  is guarded because restricted and private browsing modes throw on the getter
 *  itself, and a reminder must never break the screen behind it. */
function readDismissed(key: string) {
  try {
    return globalThis.sessionStorage?.getItem(key) === '1';
  } catch {
    return false;
  }
}

function storeDismissed(key: string) {
  try {
    globalThis.sessionStorage?.setItem(key, '1');
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
 *  gates, so it never stands between someone and a check-in. */
const PasswordChangeReminder = ({ user, profilePath }: Props) => {
  const navigate = useNavigate();
  const dismissedKey = scopedStorageKey(DISMISSED_KEY, user);
  const [dismissed, setDismissed] = useState(() => readDismissed(dismissedKey));

  const dismiss = useCallback(() => {
    storeDismissed(dismissedKey);
    setDismissed(true);
  }, [dismissedKey]);

  const openPasswordForm = useCallback(() => {
    dismiss();
    if (profilePath) navigate(`${profilePath}?tab=profile&modal=profile-password`);
  }, [dismiss, navigate, profilePath]);

  // Kiosk stations are shared hardware signed in by an operator, so there is no
  // individual owner to prompt.
  if (dismissed || user.role === 'Kiosk' || !user.password_change_required) return null;

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
