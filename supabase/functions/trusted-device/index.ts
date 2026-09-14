import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

const DEVICE_TOKEN_BYTES = 32;
const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const DEVICE_GRANT_TTL_MS = 12 * 60 * 60 * 1000;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

function clean(value: unknown, max = 300) {
  return String(value ?? "").trim().slice(0, max);
}

function randomToken(bytes = DEVICE_TOKEN_BYTES) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  data.forEach((byte) => binary += String.fromCharCode(byte));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
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
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const jwt = authorization.slice("Bearer ".length);
  const { data: authData, error: authError } = await admin.auth.getUser(jwt);
  if (authError || !authData.user) return json({ ok: false, error: "Phiên đăng nhập không hợp lệ." }, 401);

  const { data: actor, error: actorError } = await admin
    .from("employees")
    .select("employee_id,role,status,organization_id")
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

    const { data: oldDevices } = await admin
      .from("trusted_devices")
      .select("device_id,device_label,activated_at")
      .eq("employee_id", employeeId)
      .eq("organization_id", actor.organization_id)
      .eq("status", "ACTIVE");
    const now = new Date().toISOString();
    const { error: revokeError } = await admin
      .from("trusted_devices")
      .update({ status: "REVOKED", revoked_at: now, revoked_by: actor.employee_id, revoke_reason: reason })
      .eq("employee_id", employeeId)
      .eq("organization_id", actor.organization_id)
      .eq("status", "ACTIVE");
    if (revokeError) return json({ ok: false, error: revokeError.message }, 400);

    await admin.from("trusted_device_grants").delete().eq("employee_id", employeeId);
    await admin.from("trusted_device_challenges").delete().eq("employee_id", employeeId);
    await admin.from("employees").update({
      trusted_device_id: null,
      trusted_device_bound_at: null,
      updated_at: now,
    }).eq("employee_id", employeeId).eq("organization_id", actor.organization_id);
    await admin.from("audit_logs").insert({
      actor_employee_id: actor.employee_id,
      target_employee_id: employeeId,
      action: "TRUSTED_DEVICE_RESET",
      entity_type: "trusted_device",
      reason,
      metadata: { old_devices: oldDevices || [], organization_id: actor.organization_id },
    });
    return json({ ok: true, message: "Đã đặt lại thiết bị. Lần đăng nhập tiếp theo phải kích hoạt thiết bị mới." });
  }

  if (actor.role === "Admin" || actor.role === "Kiosk") {
    return json({ ok: true, exempt: true, state: "EXEMPT" });
  }

  const employeeId = actor.employee_id;
  const deviceId = clean(body.deviceId, 180);
  if (!deviceId || deviceId.length < 12) return json({ ok: false, error: "Thiết bị không hợp lệ." }, 400);

  const { data: activeDevice } = await admin
    .from("trusted_devices")
    .select("device_id,device_label,user_agent,activated_at,last_seen_at,status,public_key_jwk")
    .eq("employee_id", employeeId)
    .eq("organization_id", actor.organization_id)
    .eq("status", "ACTIVE")
    .maybeSingle();

  if (action === "status") {
    if (!activeDevice) return json({ ok: true, state: "NEEDS_ACTIVATION", needsActivation: true });
    if (activeDevice.device_id !== deviceId) {
      return json({ ok: false, state: "BLOCKED", error: "Tài khoản đang liên kết với thiết bị khác. Nếu mất hoặc đổi điện thoại, vui lòng liên hệ Admin." }, 403);
    }
    return json({
      ok: true,
      state: "ACTIVE",
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
    if (!activeDevice) {
      const publicKey = body.publicKey;
      if (!publicKey || typeof publicKey !== "object") return json({ ok: false, error: "Thiếu public key của thiết bị." }, 400);
      const deviceLabel = clean(body.deviceLabel, 160) || "Thiết bị làm việc";
      const userAgent = clean(body.userAgent, 500);
      const now = new Date().toISOString();
      const { error: insertError } = await admin.from("trusted_devices").insert({
        device_id: deviceId,
        employee_id: employeeId,
        organization_id: actor.organization_id,
        public_key_jwk: publicKey,
        device_label: deviceLabel,
        user_agent: userAgent,
        status: "ACTIVE",
        activated_at: now,
      });
      if (insertError) return json({ ok: false, error: insertError.message }, 400);
      await admin.from("employees").update({
        trusted_device_id: deviceId,
        trusted_device_bound_at: now,
        updated_at: now,
      }).eq("employee_id", employeeId).eq("organization_id", actor.organization_id);
      await admin.from("audit_logs").insert({
        actor_employee_id: employeeId,
        target_employee_id: employeeId,
        action: "TRUSTED_DEVICE_ACTIVATED",
        entity_type: "trusted_device",
        entity_id: deviceId,
        metadata: { device_label: deviceLabel, user_agent: userAgent, organization_id: actor.organization_id },
      });
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
    const challenge = randomToken();
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
    const { data, error } = await admin.from("trusted_device_challenges").insert({
      employee_id: employeeId,
      device_id: deviceId,
      challenge,
      expires_at: expiresAt,
    }).select("id").single();
    if (error || !data) return json({ ok: false, error: error?.message || "Không tạo được challenge." }, 400);
    return json({ ok: true, challengeId: data.id, challenge, expiresAt });
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

    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + DEVICE_GRANT_TTL_MS).toISOString();
    await admin.from("trusted_device_challenges").update({ used_at: now }).eq("id", challengeId).eq("employee_id", employeeId);
    await admin.from("trusted_devices").update({ last_seen_at: now })
      .eq("device_id", deviceId)
      .eq("employee_id", employeeId)
      .eq("organization_id", actor.organization_id);
    const { error: grantError } = await admin.from("trusted_device_grants").upsert({
      employee_id: employeeId,
      device_id: deviceId,
      verified_at: now,
      expires_at: expiresAt,
      updated_at: now,
    });
    if (grantError) return json({ ok: false, error: grantError.message }, 400);
    return json({
      ok: true,
      state: "VERIFIED",
      expiresAt,
      device: {
        deviceId,
        label: activeDevice.device_label,
        activatedAt: activeDevice.activated_at,
        lastSeenAt: now,
      },
    });
  }

  return json({ ok: false, error: "Thao tác không hợp lệ." }, 400);
});
