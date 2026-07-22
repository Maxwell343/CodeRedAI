"""
WhatsApp Webhook — POST /api/whatsapp
======================================

Interactive emergency bot using Twilio Content API for tap-based buttons
and list pickers.  Falls back to text-based TwiML if Twilio REST credentials
are not configured (graceful degradation).

State Machine
-------------
    (no session)  → user sends anything        → INIT  (show welcome + 🚨 button)
    INIT          → taps "Report Emergency"     → LOCATION_PENDING
    LOCATION_PENDING → shares GPS / types addr  → TYPE_SELECTION  (list picker)
    TYPE_SELECTION   → selects emergency type   → CONFIRMATION    (confirm/cancel)
    CONFIRMATION     → taps ✅ Confirm           → dispatch + clear session
    CONFIRMATION     → taps ❌ Cancel            → clear session

Interactive Elements (Twilio Content API)
-----------------------------------------
    welcome        : twilio/quick-reply  – 🚨 Report Emergency
    emergency_type : twilio/list-picker  – 5 emergency categories
    confirm        : twilio/quick-reply  – ✅ Confirm & Dispatch / ❌ Cancel
"""
from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timezone
from urllib.parse import parse_qs

import requests as http_requests
from fastapi import APIRouter, Request
from fastapi.responses import PlainTextResponse
from twilio.twiml.messaging_response import MessagingResponse

from database import get_emergencies_collection
from services.driver_service import create_driver_offers, find_nearest_drivers
from services.emergency_service import create_emergency, save_to_db
from services.hospital_service import find_nearest_hospitals, notify_hospitals

_logger = logging.getLogger(__name__)
router = APIRouter()

# ═══════════════════════════════════════════════════════════════════════════
# Configuration
# ═══════════════════════════════════════════════════════════════════════════

_TWILIO_SID = os.getenv("TWILIO_ACCOUNT_SID", "")
_TWILIO_TOKEN = os.getenv("TWILIO_AUTH_TOKEN", "")
_TWILIO_FROM = os.getenv("TWILIO_WHATSAPP_FROM", "whatsapp:+14155238886")
_TWILIO_MSG_SVC = os.getenv("TWILIO_MESSAGING_SERVICE_SID", "")
_INTERACTIVE_ENABLED = bool(_TWILIO_SID and _TWILIO_TOKEN)

# Twilio REST client — needed for sending interactive messages
_twilio_client = None
if _INTERACTIVE_ENABLED:
    try:
        from twilio.rest import Client as _TwilioRestClient
        _twilio_client = _TwilioRestClient(_TWILIO_SID, _TWILIO_TOKEN)
        _logger.info("[WHATSAPP] Twilio REST client ready — interactive messages ENABLED")
    except Exception as _init_exc:
        _logger.warning("[WHATSAPP] Twilio client init failed (%s) — TwiML fallback", _init_exc)
        _INTERACTIVE_ENABLED = False
else:
    _logger.info("[WHATSAPP] TWILIO_ACCOUNT_SID/AUTH_TOKEN not set — text-only TwiML mode")


# ═══════════════════════════════════════════════════════════════════════════
# Session Store  (in-memory, 10-minute TTL)
# ═══════════════════════════════════════════════════════════════════════════

_sessions: dict[str, dict] = {}
_SESSION_TTL = 600  # seconds


def _get_session(phone: str) -> dict | None:
    session = _sessions.get(phone)
    if not session:
        return None
    if (datetime.now(tz=timezone.utc).timestamp() - session.get("_ts", 0)) > _SESSION_TTL:
        _sessions.pop(phone, None)
        return None
    return session


def _set_session(phone: str, data: dict) -> None:
    data["_ts"] = datetime.now(tz=timezone.utc).timestamp()
    _sessions[phone] = data


def _clear_session(phone: str) -> None:
    _sessions.pop(phone, None)


# ═══════════════════════════════════════════════════════════════════════════
# State Constants
# ═══════════════════════════════════════════════════════════════════════════

STEP_INIT = "INIT"
STEP_LOCATION = "LOCATION_PENDING"
STEP_TYPE = "TYPE_SELECTION"
STEP_CONFIRM = "CONFIRMATION"


# ═══════════════════════════════════════════════════════════════════════════
# Emergency Type Definitions
# ═══════════════════════════════════════════════════════════════════════════

_TYPE_INFO: dict[str, dict] = {
    "heart_attack": {"label": "Heart Attack",            "emoji": "❤️",  "desc": "Chest pain, difficulty breathing"},
    "stroke":       {"label": "Stroke",                  "emoji": "🧠",  "desc": "Sudden numbness, confusion"},
    "fainting":     {"label": "Unconscious / Fainting",  "emoji": "😵",  "desc": "Loss of consciousness"},
    "accident":     {"label": "Accident",                "emoji": "🚗",  "desc": "Road accident, physical injury"},
    "other":        {"label": "Other Emergency",         "emoji": "⚠️",  "desc": "Any other medical emergency"},
}

# Fallback text mapping for environments where list picker doesn't render
_TEXT_TO_TYPE: dict[str, str] = {
    "1": "heart_attack", "heart attack": "heart_attack", "heart_attack": "heart_attack",
    "2": "stroke", "stroke": "stroke",
    "3": "fainting", "fainted": "fainting", "fainting": "fainting", "unconscious": "fainting",
    "4": "accident", "accident": "accident",
    "5": "other", "other": "other",
}


# ═══════════════════════════════════════════════════════════════════════════
# Content Template Management  (Twilio Content API)
# ═══════════════════════════════════════════════════════════════════════════
# Templates are created on first use via POST to Content API and
# their SIDs are cached in-memory for the server lifetime.

_content_sids: dict[str, str] = {}
_CONTENT_API = "https://content.twilio.com/v1/Content"

_TEMPLATE_DEFS: dict[str, dict] = {
    "welcome": {
        "friendly_name": "codered_welcome_v2",
        "language": "en",
        "types": {
            "twilio/quick-reply": {
                "body": (
                    "👋 Welcome to *CodeRed AI Emergency Response*\n\n"
                    "🆘 This system dispatches ambulances to your location in real-time.\n\n"
                    "Tap below to report an emergency:"
                ),
                "actions": [
                    {"title": "🚨 Report Emergency", "id": "report_emergency"},
                ],
            },
        },
    },
    "emergency_type": {
        "friendly_name": "codered_etype_v2",
        "language": "en",
        "variables": {"1": "Location"},
        "types": {
            "twilio/list-picker": {
                "body": (
                    "✅ *Location received!*\n"
                    "📍 {{1}}\n\n"
                    "🏥 *Step 2 of 3:* Select the type of emergency:"
                ),
                "button": "Select Emergency Type",
                "items": [
                    {"id": "heart_attack", "item": "❤️ Heart Attack",            "description": "Chest pain, difficulty breathing"},
                    {"id": "stroke",       "item": "🧠 Stroke",                  "description": "Sudden numbness, confusion"},
                    {"id": "fainting",     "item": "😵 Unconscious / Fainting",  "description": "Loss of consciousness"},
                    {"id": "accident",     "item": "🚗 Accident",                "description": "Road accident, physical injury"},
                    {"id": "other",        "item": "⚠️ Other Emergency",         "description": "Any other medical emergency"},
                ],
            },
        },
    },
    "confirm": {
        "friendly_name": "codered_confirm_v2",
        "language": "en",
        "variables": {"1": "emoji", "2": "type", "3": "address"},
        "types": {
            "twilio/quick-reply": {
                "body": (
                    "📋 *EMERGENCY SUMMARY*\n"
                    "━━━━━━━━━━━━━━━━━━━━\n"
                    "{{1}} Type: *{{2}}*\n"
                    "📍 Location: {{3}}\n"
                    "━━━━━━━━━━━━━━━━━━━━\n\n"
                    "⚡ Tap ✅ to dispatch an ambulance NOW."
                ),
                "actions": [
                    {"title": "✅ Confirm & Dispatch", "id": "confirm_emergency"},
                    {"title": "❌ Cancel",             "id": "cancel_emergency"},
                ],
            },
        },
    },
}


def _ensure_content_sid(key: str) -> str | None:
    """Get a cached Content SID or create the template via Content API."""
    if key in _content_sids:
        return _content_sids[key]

    if not _INTERACTIVE_ENABLED:
        return None

    defn = _TEMPLATE_DEFS.get(key)
    if not defn:
        return None

    try:
        resp = http_requests.post(
            _CONTENT_API,
            auth=(_TWILIO_SID, _TWILIO_TOKEN),
            json=defn,
            timeout=15,
        )
        if resp.status_code in (200, 201):
            sid = resp.json().get("sid")
            if sid:
                _content_sids[key] = sid
                _logger.info("[CONTENT] Created template '%s' → %s", key, sid)
                return sid
        _logger.warning("[CONTENT] Template '%s' → HTTP %d: %s", key, resp.status_code, resp.text[:300])
    except Exception as exc:
        _logger.warning("[CONTENT] Template '%s' creation failed: %s", key, exc)

    return None


# ═══════════════════════════════════════════════════════════════════════════
# Message Sending Helpers
# ═══════════════════════════════════════════════════════════════════════════

def _send_interactive(to: str, template_key: str, variables: dict | None = None) -> bool:
    """Send an interactive message via Twilio REST API. Returns True on success."""
    sid = _ensure_content_sid(template_key)
    if not sid or not _twilio_client:
        return False

    try:
        kwargs: dict = {"content_sid": sid, "to": to}

        # Use Messaging Service SID if available, otherwise direct from number
        if _TWILIO_MSG_SVC:
            kwargs["messaging_service_sid"] = _TWILIO_MSG_SVC
        else:
            kwargs["from_"] = _TWILIO_FROM

        if variables:
            kwargs["content_variables"] = json.dumps(variables)

        _twilio_client.messages.create(**kwargs)
        return True
    except Exception as exc:
        _logger.warning("[SEND INTERACTIVE] %s → failed: %s", template_key, exc)
        return False


def _send_text_api(to: str, body: str) -> bool:
    """Send a plain text WhatsApp message via REST API."""
    if not _twilio_client:
        return False

    try:
        kwargs: dict = {"body": body, "to": to}
        if _TWILIO_MSG_SVC:
            kwargs["messaging_service_sid"] = _TWILIO_MSG_SVC
        else:
            kwargs["from_"] = _TWILIO_FROM

        _twilio_client.messages.create(**kwargs)
        return True
    except Exception as exc:
        _logger.warning("[SEND TEXT] failed: %s", exc)
        return False


# ═══════════════════════════════════════════════════════════════════════════
# TwiML Helpers  (fallback when REST credentials are missing)
# ═══════════════════════════════════════════════════════════════════════════

def _twiml(text: str) -> PlainTextResponse:
    resp = MessagingResponse()
    resp.message(text)
    return PlainTextResponse(str(resp), media_type="application/xml")


def _empty_twiml() -> PlainTextResponse:
    """Return empty TwiML — used when we already sent via REST API."""
    return PlainTextResponse("<Response></Response>", media_type="application/xml")


# ═══════════════════════════════════════════════════════════════════════════
# Webhook Handler
# ═══════════════════════════════════════════════════════════════════════════

@router.post("/whatsapp")
async def whatsapp_webhook(request: Request) -> PlainTextResponse:
    """
    Main Twilio WhatsApp webhook.
    Reads incoming form data (text, GPS, button taps, list picks),
    drives the state machine, and responds with interactive messages
    or TwiML text fallback.
    """
    try:
        # ── Parse incoming webhook fields ──────────────────────────────
        content_type = (request.headers.get("content-type") or "").lower()
        body = ""
        phone = ""
        lat_raw = lng_raw = None
        button_payload = None
        list_id = None

        if "application/x-www-form-urlencoded" in content_type:
            raw = parse_qs(
                (await request.body()).decode("utf-8", errors="ignore"),
                keep_blank_values=True,
            )
            body           = (raw.get("Body", [""])[0] or "").strip()
            phone          = (raw.get("From", [""])[0] or "").strip()
            lat_raw        = raw.get("Latitude", [None])[0]
            lng_raw        = raw.get("Longitude", [None])[0]
            button_payload = raw.get("ButtonPayload", [None])[0]
            list_id        = raw.get("ListId", [None])[0]
        else:
            form = await request.form()
            body           = (form.get("Body") or "").strip()
            phone          = (form.get("From") or "").strip()
            lat_raw        = form.get("Latitude")
            lng_raw        = form.get("Longitude")
            button_payload = form.get("ButtonPayload")
            list_id        = form.get("ListId")

        _logger.info(
            "[WA IN] from=%s body=%r btn=%s list=%s lat=%s lng=%s",
            phone, body[:60], button_payload, list_id, lat_raw, lng_raw,
        )

        if not phone:
            return _twiml("⚠️ Invalid request — no sender number found.")

        msg_lower = body.lower()

        # ── Global reset ───────────────────────────────────────────────
        if msg_lower in {"reset", "cancel", "quit", "stop"}:
            _clear_session(phone)
            if _INTERACTIVE_ENABLED:
                _send_interactive(phone, "welcome")
                return _empty_twiml()
            return _twiml(
                "🔄 Session reset.\n\nSend *emergency* to start a new report."
            )

        session = _get_session(phone)

        # ══════════════════════════════════════════════════════════════
        # NO SESSION — Welcome screen
        # ══════════════════════════════════════════════════════════════
        if not session:
            # User tapped the "Report Emergency" button
            if button_payload == "report_emergency" or "emergency" in msg_lower:
                _set_session(phone, {"step": STEP_LOCATION})

                location_prompt = (
                    "🚨 *CODERED EMERGENCY ACTIVATED*\n\n"
                    "I'm here to help. Stay calm — help is coming.\n\n"
                    "📍 *Step 1 of 3:* Please share your location.\n\n"
                    "You can:\n"
                    "• Tap 📎 → *Location* → Send your current location\n"
                    "• Or type your address manually\n\n"
                    "_Type *cancel* at any time to reset._"
                )

                if _INTERACTIVE_ENABLED:
                    _send_text_api(phone, location_prompt)
                    return _empty_twiml()
                return _twiml(location_prompt)

            # Default: show welcome with clickable button
            if _INTERACTIVE_ENABLED:
                sent = _send_interactive(phone, "welcome")
                if sent:
                    return _empty_twiml()

            # TwiML fallback welcome
            return _twiml(
                "👋 Welcome to *CodeRed AI Emergency Response*\n\n"
                "🆘 Send *emergency* to activate emergency assistance.\n\n"
                "_This system dispatches ambulances in real-time._"
            )

        # ══════════════════════════════════════════════════════════════
        # STEP: LOCATION_PENDING — Collect GPS or text address
        # ══════════════════════════════════════════════════════════════
        if session["step"] == STEP_LOCATION:
            lat, lng = None, None
            address = body if body else "Location not provided"

            # Native WhatsApp GPS location share
            if lat_raw and lng_raw:
                try:
                    lat = float(lat_raw)
                    lng = float(lng_raw)
                    address = body if body else f"{lat:.6f}, {lng:.6f}"
                except ValueError:
                    pass
            else:
                # Try parsing coordinates from text: "19.0760, 72.8777"
                coord_match = re.search(
                    r"(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)", body
                )
                if coord_match:
                    try:
                        plat = float(coord_match.group(1))
                        plng = float(coord_match.group(2))
                        if -90 <= plat <= 90 and -180 <= plng <= 180:
                            lat, lng = plat, plng
                    except ValueError:
                        pass

            session["latitude"] = lat
            session["longitude"] = lng
            session["address"] = address
            session["step"] = STEP_TYPE
            _set_session(phone, session)

            # Send emergency type picker
            if _INTERACTIVE_ENABLED:
                sent = _send_interactive(phone, "emergency_type", {"1": address})
                if sent:
                    return _empty_twiml()

            # TwiML text fallback
            return _twiml(
                f"✅ *Location received!*\n"
                f"📍 {address}\n\n"
                "🏥 *Step 2 of 3:* What type of emergency?\n\n"
                "Reply with a number:\n"
                "1️⃣ Heart Attack\n"
                "2️⃣ Stroke\n"
                "3️⃣ Fainting / Unconscious\n"
                "4️⃣ Accident\n"
                "5️⃣ Other Emergency"
            )

        # ══════════════════════════════════════════════════════════════
        # STEP: TYPE_SELECTION — Collect emergency type
        # ══════════════════════════════════════════════════════════════
        if session["step"] == STEP_TYPE:
            emergency_type = None

            # Interactive: list picker sends ListId
            if list_id and list_id in _TYPE_INFO:
                emergency_type = list_id

            # Interactive: some versions send ButtonPayload
            elif button_payload and button_payload in _TYPE_INFO:
                emergency_type = button_payload

            # Text body matching (list picker also sends item title as Body)
            elif body:
                body_lower = body.lower().strip()
                # Check label matches (e.g. "❤️ Heart Attack")
                for type_key, info in _TYPE_INFO.items():
                    if info["label"].lower() in body_lower:
                        emergency_type = type_key
                        break
                # Check numeric / text shortcuts
                if not emergency_type:
                    emergency_type = _TEXT_TO_TYPE.get(body_lower)

            if not emergency_type:
                if _INTERACTIVE_ENABLED:
                    _send_text_api(phone, "Please select one of the options above 👆")
                    return _empty_twiml()
                return _twiml(
                    "⚠️ Please select a valid option:\n\n"
                    "1️⃣ Heart Attack\n"
                    "2️⃣ Stroke\n"
                    "3️⃣ Fainting / Unconscious\n"
                    "4️⃣ Accident\n"
                    "5️⃣ Other Emergency"
                )

            info = _TYPE_INFO[emergency_type]
            session["emergency_type"] = emergency_type
            session["step"] = STEP_CONFIRM
            _set_session(phone, session)

            # Send confirmation screen with Confirm / Cancel buttons
            if _INTERACTIVE_ENABLED:
                sent = _send_interactive(phone, "confirm", {
                    "1": info["emoji"],
                    "2": info["label"],
                    "3": session.get("address", "Unknown"),
                })
                if sent:
                    return _empty_twiml()

            # TwiML fallback
            return _twiml(
                f"📋 *EMERGENCY SUMMARY*\n"
                f"{'━' * 20}\n"
                f"{info['emoji']} Type: *{info['label']}*\n"
                f"📍 Location: {session.get('address', 'Unknown')}\n"
                f"{'━' * 20}\n\n"
                "Reply *confirm* to dispatch an ambulance NOW.\n"
                "Reply *cancel* to abort."
            )

        # ══════════════════════════════════════════════════════════════
        # STEP: CONFIRMATION — Dispatch or cancel
        # ══════════════════════════════════════════════════════════════
        if session["step"] == STEP_CONFIRM:
            is_confirm = (
                button_payload == "confirm_emergency"
                or msg_lower in {"confirm", "yes", "y", "ok"}
            )
            is_cancel = (
                button_payload == "cancel_emergency"
                or msg_lower in {"cancel", "no", "n"}
            )

            # ── Cancel ────────────────────────────────────────────────
            if is_cancel:
                _clear_session(phone)
                if _INTERACTIVE_ENABLED:
                    _send_text_api(
                        phone,
                        "❌ Emergency cancelled.\n\nSend any message to start again.",
                    )
                    return _empty_twiml()
                return _twiml("❌ Emergency cancelled.\n\nSend *emergency* to start again.")

            # ── Invalid input ─────────────────────────────────────────
            if not is_confirm:
                if _INTERACTIVE_ENABLED:
                    _send_text_api(phone, "Please tap ✅ *Confirm* or ❌ *Cancel* above 👆")
                    return _empty_twiml()
                return _twiml("Reply *confirm* to dispatch or *cancel* to abort.")

            # ── Idempotency guard ─────────────────────────────────────
            if session.get("dispatched"):
                msg = "⚠️ Emergency already dispatched. Help is on the way!"
                if _INTERACTIVE_ENABLED:
                    _send_text_api(phone, msg)
                    return _empty_twiml()
                return _twiml(msg)

            session["dispatched"] = True
            _set_session(phone, session)

            emergency_type = session.get("emergency_type", "other")
            info = _TYPE_INFO.get(emergency_type, _TYPE_INFO["other"])

            # ── Progressive feedback ──────────────────────────────────
            if _INTERACTIVE_ENABLED:
                _send_text_api(phone, "🔍 Searching nearby ambulances and hospitals…")

            # ── BUILD AND PERSIST EMERGENCY ───────────────────────────
            doc = create_emergency(
                phone_number=phone,
                lat=session.get("latitude"),
                lng=session.get("longitude"),
                address=session.get("address", "Unknown"),
                emergency_type=emergency_type,
            )
            emergency_id = save_to_db(doc)

            # ── DISPATCH ──────────────────────────────────────────────
            lat = session.get("latitude")
            lng = session.get("longitude")
            hospitals: list = []
            drivers: list = []

            if emergency_id:
                if lat is not None and lng is not None:
                    hospitals = find_nearest_hospitals(lat, lng)
                    notify_hospitals(emergency_id, hospitals)
                    drivers = find_nearest_drivers(lat, lng)
                else:
                    drivers = find_nearest_drivers(0.0, 0.0)

                create_driver_offers(emergency_id, drivers)

                # Update emergency status in MongoDB
                if hospitals or drivers:
                    try:
                        from bson import ObjectId

                        new_status = "DRIVER_NOTIFIED" if drivers else "HOSPITAL_NOTIFIED"
                        get_emergencies_collection().update_one(
                            {"_id": ObjectId(emergency_id)},
                            {"$set": {
                                "status": new_status,
                                "updated_at": datetime.now(tz=timezone.utc),
                            }},
                        )
                    except Exception:
                        pass  # Non-critical

            _logger.info(
                "[WA DISPATCH] phone=%s type=%s hospitals=%d drivers=%d id=%s",
                phone, emergency_type, len(hospitals), len(drivers), emergency_id,
            )

            # ── Build final confirmation message ──────────────────────
            if hospitals or drivers:
                final_msg = (
                    f"🚨 *EMERGENCY DISPATCHED!*\n"
                    f"{'━' * 28}\n"
                    f"{info['emoji']} Emergency: *{info['label']}*\n"
                    f"📍 Location: {session.get('address', 'Unknown')}\n"
                    f"🏥 Hospitals Notified: *{len(hospitals)}*\n"
                    f"🚑 Drivers Alerted: *{len(drivers)}*\n"
                    f"{'━' * 28}\n"
                )
                if emergency_id:
                    final_msg += f"📋 Case ID: {emergency_id[:12]}…\n\n"
                final_msg += (
                    "✅ *Help is on the way!*\n"
                    "An ambulance will be dispatched the moment a driver accepts.\n"
                    "Please stay calm and keep your phone nearby.\n\n"
                    "_Send any message to report another emergency._"
                )
            else:
                final_msg = (
                    f"🚨 *EMERGENCY RECORDED*\n"
                    f"{'━' * 28}\n"
                    f"{info['emoji']} Emergency: *{info['label']}*\n"
                    f"📍 Location: {session.get('address', 'Unknown')}\n"
                    f"{'━' * 28}\n"
                )
                if emergency_id:
                    final_msg += f"📋 Case ID: {emergency_id[:12]}…\n\n"
                final_msg += (
                    "⚠️ *Notice:* No active hospitals or drivers found within 5 km.\n"
                    "Central dispatch has been flagged. Please also contact local emergency services.\n\n"
                    "_Send any message to report another emergency._"
                )

            # Clear session — dispatch is complete
            _clear_session(phone)

            if _INTERACTIVE_ENABLED:
                _send_text_api(phone, final_msg)
                return _empty_twiml()
            return _twiml(final_msg)

        # ══════════════════════════════════════════════════════════════
        # Fallback — unknown state → reset
        # ══════════════════════════════════════════════════════════════
        _clear_session(phone)
        if _INTERACTIVE_ENABLED:
            _send_interactive(phone, "welcome")
            return _empty_twiml()
        return _twiml(
            "⚠️ Session reset.\n\nSend *emergency* to start again."
        )

    except Exception as exc:
        _logger.exception("[WA ERROR] Unhandled: %s", exc)
        resp = MessagingResponse()
        resp.message("⚠️ Server error. Please try again in a moment.")
        return PlainTextResponse(str(resp), media_type="application/xml")