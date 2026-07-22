from __future__ import annotations

from fastapi import APIRouter, Response, status

from schemas.auth import (
    AdminAuthResponse,
    AdminSignupRequest,
    DriverAuthResponse,
    DriverSignupRequest,
    HospitalAuthResponse,
    HospitalSignupRequest,
    LoginRequest,
    PresetDriverResponse,
    PresetHospitalResponse,
)
from services.auth_service import (
    get_preset_drivers,
    get_preset_hospitals,
    login_admin,
    login_driver,
    login_hospital,
    signup_admin,
    signup_driver,
    signup_hospital,
)
from utils.jwt_handler import set_access_cookie

router = APIRouter()


@router.post("/hospital/signup", response_model=HospitalAuthResponse, status_code=status.HTTP_201_CREATED)
async def hospital_signup(payload: HospitalSignupRequest, response: Response):
    result = signup_hospital(payload)
    set_access_cookie(response, result.token)
    return {
        "success": True,
        "message": "Hospital account created.",
        "token": result.token,
        "user": result.user,
    }


@router.post("/hospital/login", response_model=HospitalAuthResponse)
async def hospital_login(payload: LoginRequest, response: Response):
    result = login_hospital(payload)
    set_access_cookie(response, result.token)
    return {
        "success": True,
        "message": "Login successful.",
        "token": result.token,
        "user": result.user,
    }


@router.get("/hospital/presets", response_model=PresetHospitalResponse)
async def hospital_presets():
    return get_preset_hospitals()


@router.post("/driver/signup", response_model=DriverAuthResponse, status_code=status.HTTP_201_CREATED)
async def driver_signup(payload: DriverSignupRequest, response: Response):
    result = signup_driver(payload)
    set_access_cookie(response, result.token)
    return {
        "success": True,
        "message": "Driver account created.",
        "token": result.token,
        "user": result.user,
    }


@router.post("/driver/login", response_model=DriverAuthResponse)
async def driver_login(payload: LoginRequest, response: Response):
    result = login_driver(payload)
    set_access_cookie(response, result.token)
    return {
        "success": True,
        "message": "Login successful.",
        "token": result.token,
        "user": result.user,
    }


@router.get("/driver/presets", response_model=PresetDriverResponse)
async def driver_presets():
    return get_preset_drivers()


@router.post("/admin/signup", response_model=AdminAuthResponse, status_code=status.HTTP_201_CREATED)
async def admin_signup(payload: AdminSignupRequest, response: Response):
    result = signup_admin(payload)
    set_access_cookie(response, result.token)
    return {
        "success": True,
        "message": "Admin account created.",
        "token": result.token,
        "user": result.user,
    }


@router.post("/admin/login", response_model=AdminAuthResponse)
async def admin_login(payload: LoginRequest, response: Response):
    result = login_admin(payload)
    set_access_cookie(response, result.token)
    return {
        "success": True,
        "message": "Login successful.",
        "token": result.token,
        "user": result.user,
    }
