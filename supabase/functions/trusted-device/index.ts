import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

const CHALLENGE_TTL_SECONDS = 2 * 60;
const DEVICE_GRANT_TTL_SECONDS = 12 * 60 * 60;

interface DeviceStateResult {
  ok?: boolean;
  code?: string;
  verified_at?: string;
  expires_at?: string;
  challenge_id?: string;
  challenge?: string;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

function clean(value: unknown, max = 300) {
  return String(value ?? "").trim().slice(0, max);
}

// Mirrors normalizeDeviceLockRoles in src/shared/constants. A value that cannot
// be read falls back to the default rather than to an empty list, so a corrupt
// setting can never switch device binding off for the whole tenant. Kiosk is
// absent from the editable set and can therefore never be locked.
const DEVICE_LOCK_EDITABLE_ROLES = ["Staff", "Leader", "Manager", "Director", "HR", "Admin"];
const DEFAULT_DEVICE_LOCK_ROLES = ["Staff", "Leader", "Manager", "Director", "HR"];

function deviceLockRoles(raw: unknown): string[] {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
  }
  if (!Array.isArray(parsed)) return [...DEFAULT_DEVICE_LOCK_ROLES];
  return [...new Set(parsed.filter((role): role is string => DEVICE_LOCK_EDITABLE_ROLES.includes(role as string)))];
}

function base64UrlToBytes(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const authorization = request.headers.get("authorization");
  if (!url || !serviceRoleKey || !authorization?.startsWith("Bearer ")) {
    return json({ ok: false, error: "Phiên xác thực không hợp lệ." }, 401);
  }

  const admin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const jwt = authorization.slice("Bearer ".length);
  const { data: authData, error: authError } = await admin.auth.getUser(jwt);
  if (authError || !authData.user) return json({ ok: false, error: "Phiên đăng nhập không hợp lệ." }, 401);

  const { data: actor, error: actorError } = await admin
    .from("employees")
    .select("employee_id,role,status,organization_id,device_lock_required")
    .eq("auth_user_id", authData.user.id)
    .single();
  if (actorError || !actor || actor.status !== "Active" || !actor.organization_id) {
    return json({ ok: false, error: "Không tìm thấy tài khoản đang hoạt động." }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Dữ liệu gửi lên không hợp lệ." }, 400);
  }
  const action = clean(body.action, 40);

  if (action === "admin-reset") {
    if (actor.role !== "Admin") return json({ ok: false, error: "Chỉ Admin được đặt lại thiết bị." }, 403);
    const { data: employeeOverride, error: employeeOverrideError } = await admin
      .from("workforce_employee_capabilities")
      .select("enabled")
      .eq("organization_id", actor.organization_id)
      .eq("employee_id", actor.employee_id)
      .eq("capability", "kiosk.manage")
      .maybeSingle();
    if (employeeOverrideError) return json({ ok: false, error: "Không kiểm tra được quyền quản lý thiết bị." }, 500);
    let canManageDevices = employeeOverride?.enabled;
    if (canManageDevices === undefined) {
      const { data: roleCapability, error: roleCapabilityError } = await admin
        .from("workforce_role_capabilities")
        .select("enabled")
        .eq("organization_id", actor.organization_id)
        .eq("role", actor.role)
        .eq("capability", "kiosk.manage")
        .maybeSingle();
      if (roleCapabilityError) return json({ ok: false, error: "Không kiểm tra được quyền quản lý thiết bị." }, 500);
      canManageDevices = roleCapability?.enabled ?? false;
    }
    if (!canManageDevices) return json({ ok: false, error: "Tài khoản không có quyền quản lý thiết bị." }, 403);
    const employeeId = clean(body.employeeId, 40).toUpperCase();
    const reason = clean(body.reason, 500);
    if (!employeeId || reason.length < 3) {
      return json({ ok: false, error: "Cần nhân viên và lý do đặt lại thiết bị." }, 400);
    }

    const { data: target, error: targetError } = await admin
      .from("employees")
      .select("employee_id,organization_id")
      .eq("employee_id", employeeId)
      .eq("organization_id", actor.organization_id)
      .maybeSingle();
    if (targetError || !target) {
      return json({ ok: false, error: "Không tìm thấy nhân viên trong tổ chức hiện tại." }, 404);
    }

    const { data: resetData, error: resetError } = await admin.rpc("reset_trusted_device_v1", {
      p_employee_id: employeeId,
      p_actor_employee_id: actor.employee_id,
      p_reason: reason,
    });
    const resetResult = resetData as DeviceStateResult | null;
    if (resetError) {
      console.error("Trusted device reset RPC failed", { code: resetError.code, employeeId });
      return json({ ok: false, error: "Không thể đặt lại thiết bị lúc này." }, 500);
    }
    if (!resetResult?.ok) {
      return json({ ok: false, error: "Không tìm thấy nhân viên để đặt lại thiết bị." }, 404);
    }

    return json({ ok: true, message: "Đã đặt lại thiết bị. Lần đăng nhập tiếp theo phải kích hoạt thiết bị mới." });
  }

  // Which roles must bind a device is tenant configuration, resolved here rather
  // than in the browser: a client that could answer this for itself could also
  // decline to bind at all. A Kiosk station is shared hardware with no individual
  // owner, so it is exempt regardless of what is configured.
  if (actor.role === "Kiosk") {
    return json({ ok: true, exempt: true, state: "EXEMPT" });
  }

  // An explicit per-employee decision outranks the role policy in both
  // directions, so the tenant setting is only consulted when the employee has
  // none. Reading it lazily also keeps the common case to one query.
  let locked: boolean;
  if (typeof actor.device_lock_required === "boolean") {
    locked = actor.device_lock_required;
  } else {
    const { data: lockSetting, error: lockSettingError } = await admin
      .from("config_system")
      .select("value")
      .eq("organization_id", actor.organization_id)
      .eq("key", "DEVICE_LOCK_ROLES")
      .maybeSingle();
    if (lockSettingError) {
      // Fail closed: an unreadable policy keeps device proof required rather than
      // handing out an exemption the administrator never granted.
      return json({ ok: false, error: "Không đọc được chính sách khóa thiết bị." }, 500);
    }
    locked = deviceLockRoles(lockSetting?.value).includes(actor.role);
  }
  if (!locked) {
    return json({ ok: true, exempt: true, state: "EXEMPT" });
  }

  const employeeId = actor.employee_id;
  const deviceId = clean(body.deviceId, 180);
  if (!deviceId || deviceId.length < 12) return json({ ok: false, error: "Thiết bị không hợp lệ." }, 400);

  const { data: activeDevice, error: activeDeviceError } = await admin
    .from("trusted_devices")
    .select("device_id,device_label,user_agent,activated_at,last_seen_at,status,public_key_jwk")
    .eq("employee_id", employeeId)
    .eq("organization_id", actor.organization_id)
    .eq("status", "ACTIVE")
    .maybeSingle();
  if (activeDeviceError) {
    console.error("Trusted device lookup failed", { code: activeDeviceError.code, employeeId });
    return json({ ok: false, error: "Không kiểm tra được thiết bị tin cậy." }, 500);
  }

  if (action === "status") {
    if (!activeDevice) return json({ ok: true, state: "NEEDS_ACTIVATION", needsActivation: true });
    if (activeDevice.device_id !== deviceId) {
      return json({ ok: false, state: "BLOCKED", error: "Tài khoản đang liên kết với thiết bị khác. Nếu mất hoặc đổi điện thoại, vui lòng liên hệ Admin." }, 403);
    }
    const { data: activeGrant, error: activeGrantError } = await admin
      .from("trusted_device_grants")
      .select("expires_at")
      .eq("employee_id", employeeId)
      .eq("device_id", deviceId)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    if (activeGrantError) {
      console.error("Trusted device grant lookup failed", { code: activeGrantError.code, employeeId });
      return json({ ok: false, error: "Không kiểm tra được phiên thiết bị tin cậy." }, 500);
    }
    return json({
      ok: true,
      state: activeGrant ? "VERIFIED" : "ACTIVE",
      ...(activeGrant ? { expiresAt: activeGrant.expires_at } : {}),
      device: {
        deviceId: activeDevice.device_id,
        label: activeDevice.device_label,
        activatedAt: activeDevice.activated_at,
        lastSeenAt: activeDevice.last_seen_at,
      },
    });
  }

  if (action === "activate") {
    if (activeDevice && activeDevice.device_id !== deviceId) {
      return json({ ok: false, state: "BLOCKED", error: "Tài khoản đã liên kết với thiết bị khác. Liên hệ Admin để đặt lại thiết bị." }, 403);
    }
    const publicKey = body.publicKey;
    if (!publicKey || typeof publicKey !== "object") return json({ ok: false, error: "Thiếu public key của thiết bị." }, 400);
    const { data: activationData, error: activationError } = await admin.rpc("activate_trusted_device_v1", {
      p_employee_id: employeeId,
      p_device_id: deviceId,
      p_public_key_jwk: publicKey,
      p_device_label: clean(body.deviceLabel, 160) || "Thiết bị làm việc",
      p_user_agent: clean(body.userAgent, 500),
    });
    const activation = activationData as DeviceStateResult | null;
    if (activationError) {
      console.error("Trusted device activation RPC failed", { code: activationError.code, employeeId });
      return json({ ok: false, error: "Không thể kích hoạt thiết bị lúc này." }, 500);
    }
    if (!activation?.ok) {
      const message = activation?.code === "DEVICE_ALREADY_BOUND"
        ? "Tài khoản đã liên kết với thiết bị khác. Liên hệ Admin để đặt lại thiết bị."
        : activation?.code === "DEVICE_KEY_MISMATCH"
          ? "Khóa bảo mật của thiết bị không khớp. Liên hệ Admin để đặt lại thiết bị."
          : "Thiết bị không thể được liên kết với tài khoản này.";
      return json({ ok: false, state: "BLOCKED", error: message }, 403);
    }
    return json({ ok: true, state: "ACTIVE", message: "Thiết bị đã được kích hoạt." });
  }

  if (!activeDevice || activeDevice.device_id !== deviceId) {
    return json({
      ok: false,
      state: activeDevice ? "BLOCKED" : "NEEDS_ACTIVATION",
      error: activeDevice ? "Thiết bị không khớp thiết bị đã đăng ký." : "Thiết bị chưa được kích hoạt.",
    }, 403);
  }

  if (action === "challenge") {
    const { data, error } = await admin.rpc("create_trusted_device_challenge_v1", {
      p_employee_id: employeeId,
      p_device_id: deviceId,
      p_ttl_seconds: CHALLENGE_TTL_SECONDS,
    });
    const created = data as DeviceStateResult | null;
    if (error) {
      console.error("Trusted device challenge RPC failed", { code: error.code, employeeId });
      return json({ ok: false, error: "Không tạo được challenge." }, 500);
    }
    if (!created?.ok || !created.challenge_id || !created.challenge || !created.expires_at) {
      return json({ ok: false, state: "BLOCKED", error: "Thiết bị đã bị thu hồi hoặc không còn khớp." }, 403);
    }
    return json({
      ok: true,
      challengeId: created.challenge_id,
      challenge: created.challenge,
      expiresAt: created.expires_at,
    });
  }

  if (action === "verify") {
    const challengeId = clean(body.challengeId, 80);
    const signatureText = clean(body.signature, 1000);
    if (!challengeId || !signatureText) return json({ ok: false, error: "Thiếu chữ ký xác thực." }, 400);
    const { data: challengeRow, error: challengeError } = await admin
      .from("trusted_device_challenges")
      .select("id,challenge,expires_at,used_at")
      .eq("id", challengeId)
      .eq("employee_id", employeeId)
      .eq("device_id", deviceId)
      .maybeSingle();
    if (challengeError || !challengeRow || challengeRow.used_at || new Date(challengeRow.expires_at).getTime() < Date.now()) {
      return json({ ok: false, error: "Challenge đã hết hạn. Vui lòng thử lại." }, 400);
    }

    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        activeDevice.public_key_jwk as JsonWebKey,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      const valid = await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        base64UrlToBytes(signatureText),
        new TextEncoder().encode(challengeRow.challenge),
      );
      if (!valid) return json({ ok: false, state: "BLOCKED", error: "Không xác minh được khóa thiết bị." }, 403);
    } catch (error) {
      console.error("Device signature verification failed", error);
      return json({ ok: false, error: "Không xác minh được chữ ký thiết bị." }, 400);
    }

    const { data: consumeData, error: consumeError } = await admin.rpc("consume_trusted_device_challenge_v1", {
      p_challenge_id: challengeId,
      p_employee_id: employeeId,
      p_device_id: deviceId,
      p_grant_seconds: DEVICE_GRANT_TTL_SECONDS,
    });
    const consumeResult = consumeData as DeviceStateResult | null;
    if (consumeError) {
      console.error("Trusted device challenge consume RPC failed", { code: consumeError.code, employeeId });
      return json({ ok: false, error: "Không thể hoàn tất xác minh thiết bị." }, 500);
    }
    if (!consumeResult?.ok) {
      return json({
        ok: false,
        state: "BLOCKED",
        error: "Challenge đã được dùng, hết hạn hoặc thiết bị đã bị thu hồi. Vui lòng thử lại.",
      }, 409);
    }

    const verifiedAtValue = new Date(consumeResult.verified_at || "");
    const verifiedAt = Number.isNaN(verifiedAtValue.getTime()) ? new Date() : verifiedAtValue;
    const expiresAtValue = new Date(consumeResult.expires_at || "");
    const expiresAt = Number.isNaN(expiresAtValue.getTime())
      ? new Date(verifiedAt.getTime() + DEVICE_GRANT_TTL_SECONDS * 1000).toISOString()
      : expiresAtValue.toISOString();
    return json({
      ok: true,
      state: "VERIFIED",
      expiresAt,
      device: {
        deviceId,
        label: activeDevice.device_label,
        activatedAt: activeDevice.activated_at,
        lastSeenAt: verifiedAt.toISOString(),
      },
    });
  }

  return json({ ok: false, error: "Thao tác không hợp lệ." }, 400);
});
