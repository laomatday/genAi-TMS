import React, { useState } from 'react';
import { doLogin } from '@/core/auth/authService';
import { triggerHaptic } from '@/core/utils/helpers';
import { Employee } from '@/shared/types';
import { APP_INFO } from '@/shared/constants';
import { isSupabaseConfigured } from '@/core/supabase';

interface Props {
  onLoginSuccess: (user: Employee) => void;
}

const LoginView: React.FC<Props> = ({ onLoginSuccess }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleLoginWithCredentials = async (loginId: string, pass: string) => {
    setError('');
    setLoading(true);
    const res = await doLogin(loginId, pass);
    setLoading(false);

    if (res.success && res.data) {
      triggerHaptic('success');
      onLoginSuccess(res.data);
    } else {
      triggerHaptic('error');
      setError(res.message || 'Đăng nhập thất bại. Kiểm tra lại thông tin và thử lại.');
    }
  };

  const handleLogin = async () => {
    if (!email || !password) {
      setError('Vui lòng nhập tài khoản và mật khẩu.');
      return;
    }
    await handleLoginWithCredentials(email, password);
  };

  const handleQuickDemoLogin = async (role: 'admin' | 'staff') => {
    const loginId = role === 'admin' ? 'admin' : 'nhanvien';
    setEmail(loginId);
    setPassword('demo1234');
    await handleLoginWithCredentials(loginId, 'demo1234');
  };

  return (
    <main className="w-full h-full page-bg flex flex-col justify-between px-6 py-8 relative overflow-hidden transition-colors duration-300">
      <div className="login-brand-orb absolute -top-28 -right-24 w-72 h-72 rounded-full opacity-10 pointer-events-none" />
      <div className="absolute -bottom-36 -left-28 w-80 h-80 rounded-full bg-primary/5 dark:bg-primary/10 pointer-events-none" />

      <div className="flex-1 flex flex-col justify-center max-w-sm mx-auto w-full z-10 animate-slide-up">
        <section className="mb-8 text-center">
          <div className="w-24 h-24 mx-auto mb-4 rounded-3xl bg-white dark:bg-dark-surface border border-slate-100 dark:border-dark-border shadow-sm flex items-center justify-center p-3">
            <img src={APP_INFO.LOGO_URL} className="w-full h-full object-contain" alt={APP_INFO.BRAND} />
          </div>
          <p className="text-xs font-bold text-primary mb-1">{APP_INFO.BRAND}</p>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-dark-text-primary tracking-tight">{APP_INFO.NAME}</h1>
          <p className="text-slate-500 dark:text-dark-text-secondary mt-1.5 text-xs leading-relaxed">
            Hệ thống chấm công định danh và quản lý thời gian
          </p>
        </section>

        {!isSupabaseConfigured && (
          <div className="mb-4 p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/40 rounded-2xl text-xs text-amber-800 dark:text-amber-300 flex items-start gap-2">
            <span className="material-symbols-rounded text-base mt-0.5 shrink-0 text-amber-600 dark:text-amber-400">info</span>
            <div>
              <span className="font-semibold">Chế độ trải nghiệm (Demo)</span>
              <p className="text-[11px] text-amber-700 dark:text-amber-400/90 mt-0.5">
                Bạn có thể bấm vào các nút truy cập nhanh bên dưới để dùng thử ngay hoặc nhập tài khoản cá nhân.
              </p>
            </div>
          </div>
        )}

        <form
          className="space-y-4 bg-white/90 dark:bg-dark-surface/90 backdrop-blur-xl border border-slate-100 dark:border-dark-border rounded-3xl p-5 shadow-sm"
          onSubmit={(e) => {
            e.preventDefault();
            void handleLogin();
          }}
        >
          {error && (
            <div role="alert" className="flex items-start gap-3 bg-secondary-red/10 p-3 rounded-xl border border-secondary-red/20 animate-scale-in">
              <span className="material-symbols-rounded text-secondary-red text-lg mt-0.5">error</span>
              <span className="text-secondary-red text-xs font-semibold leading-relaxed">{error}</span>
            </div>
          )}

          <div className="space-y-1.5">
            <label htmlFor="login-account" className="block text-xs font-semibold text-slate-600 dark:text-dark-text-secondary">Tài khoản</label>
            <div className="relative group">
              <span className="material-symbols-rounded absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-primary transition-colors text-lg">person</span>
              <input id="login-account" type="text" value={email} inputMode="email" enterKeyHint="next" autoComplete="username" onChange={(e) => setEmail(e.target.value)} className="input-field pl-11 pr-4 text-sm" placeholder="Mã nhân viên hoặc email" />
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="login-password" className="block text-xs font-semibold text-slate-600 dark:text-dark-text-secondary">Mật khẩu</label>
            <div className="relative group">
              <span className="material-symbols-rounded absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-primary transition-colors text-lg">lock</span>
              <input id="login-password" type={showPassword ? 'text' : 'password'} value={password} enterKeyHint="go" autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} className="input-field pl-11 pr-12 text-sm" placeholder="Nhập mật khẩu" />
              <button type="button" aria-label={showPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'} onClick={() => setShowPassword((value) => !value)} className="absolute right-1.5 top-1/2 -translate-y-1/2 w-9 h-9 rounded-lg flex items-center justify-center text-slate-400 hover:text-primary">
                <span className="material-symbols-rounded text-lg">{showPassword ? 'visibility_off' : 'visibility'}</span>
              </button>
            </div>
          </div>

          <button type="submit" disabled={loading} className="w-full h-11 bg-primary text-white rounded-xl font-bold text-sm hover:bg-primary/90 active:scale-95 transition-all disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-sm">
            {loading ? <><span className="material-symbols-rounded animate-spin text-base">progress_activity</span>Đang đăng nhập</> : <>Đăng nhập<span className="material-symbols-rounded text-lg">arrow_forward</span></>}
          </button>
        </form>

        <div className="mt-4 flex flex-col gap-2">
          <div className="flex items-center gap-2 text-xs text-slate-400 dark:text-dark-text-secondary before:flex-1 before:h-px before:bg-slate-200 dark:before:bg-dark-border after:flex-1 after:h-px after:bg-slate-200 dark:after:bg-dark-border">
            <span>Dùng thử nhanh</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => void handleQuickDemoLogin('admin')}
              disabled={loading}
              className="py-2.5 px-3 bg-slate-100 dark:bg-dark-surface hover:bg-primary/10 hover:text-primary dark:hover:bg-primary/20 text-slate-700 dark:text-dark-text-primary rounded-xl text-xs font-semibold border border-slate-200 dark:border-dark-border transition-all flex items-center justify-center gap-1.5"
            >
              <span className="material-symbols-rounded text-base text-primary">admin_panel_settings</span>
              <span>Portal Quản trị</span>
            </button>
            <button
              type="button"
              onClick={() => void handleQuickDemoLogin('staff')}
              disabled={loading}
              className="py-2.5 px-3 bg-slate-100 dark:bg-dark-surface hover:bg-primary/10 hover:text-primary dark:hover:bg-primary/20 text-slate-700 dark:text-dark-text-primary rounded-xl text-xs font-semibold border border-slate-200 dark:border-dark-border transition-all flex items-center justify-center gap-1.5"
            >
              <span className="material-symbols-rounded text-base text-emerald-500">badge</span>
              <span>App Nhân viên</span>
            </button>
          </div>
        </div>
      </div>

      <footer className="text-center pb-safe z-10 mt-4">
        <p className="text-[11px] text-slate-400 dark:text-dark-text-secondary">Powered by <span className="font-bold text-primary">{APP_INFO.BRAND}</span> · {new Date().getFullYear()}</p>
      </footer>
    </main>
  );
};

export default LoginView;
