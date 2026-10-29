# -*- coding: utf-8 -*-
"""用 Windows Media Foundation (MF) 解码任意受支持格式为 PCM。

背景：本机无 ffmpeg，且 sphn（demucs v4.1.0 自带解码器）无法解码容器格式
（sphn.read 报 "no channel"）。Windows 自带 MF 可以解码 MP3/M4A/AAC/WMA，
因此这里通过 ctypes 调用 COM 接口取 PCM，避免为了转码而安装大型依赖。

用法:
    wt.wav = decode_to_wav(src_path, out_wav_path, target_sr=44100, channels=2)

输出：16-bit 小端、交错声道 WAV。
"""
from __future__ import annotations

import ctypes
import struct
from ctypes import POINTER, byref, c_ubyte, c_uint32, c_void_p
from ctypes.wintypes import BOOL, DWORD, GUID, HANDLE, LPCWSTR, LPVOID

MF_VERSION = (0x00020070 << 16) | 0
MFSTARTUP_FULL = 0
MF_SOURCE_READER_FIRST_AUDIO_STREAM = 0xFFFFFFFD
MF_SOURCE_READERF_ENDOFSTREAM = 0x00000002
MF_SOURCE_READERF_STREAMTICK = 0x00000100
MFMediaType_Audio = GUID(0x73647561, 0x0000, 0x0010, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71)
MFAudioFormat_PCM = GUID(0x00000001, 0x0000, 0x0010, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71)
MFVideoFormat_Base = GUID(0x00000000, 0x0000, 0x0010, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71)
MF_PD_DURATION = GUID(0x6C990D33, 0xBB8E, 0x477A, 0x85, 0x98, 0x0D, 0x5D, 0x96, 0xFC, 0xD8, 0xBA)
MF_SOURCE_READER_ENABLE_AUDIO_PROCESSING = 1
MF_SINK_WRITER = None

# WAVEFORMATEX / WAVEFORMATEXTENSIBLE
WAVE_FORMAT_PCM = 1
WAVE_FORMAT_EXTENSIBLE = 0xFFFE


class WAVEFORMATEX(ctypes.Structure):
    _pack_ = 2
    _fields_ = [
        ("wFormatTag", ctypes.c_ushort),
        ("nChannels", ctypes.c_ushort),
        ("nSamplesPerSec", ctypes.c_uint32),
        ("nAvgBytesPerSec", ctypes.c_uint32),
        ("nBlockAlign", ctypes.c_ushort),
        ("wBitsPerSample", ctypes.c_ushort),
        ("cbSize", ctypes.c_ushort),
    ]


class PROPVARIANT(ctypes.Structure):
    _fields_ = [("vt", ctypes.c_ushort), ("_pad", ctypes.c_ushort * 3), ("data", ctypes.c_ubyte * 16)]


mfplat = ctypes.WinDLL("mfplat.dll")
mfreadwrite = ctypes.WinDLL("mfreadwrite.dll")
propsys = ctypes.WinDLL("propsys.dll")


class IMFAttributes(c_void_p):
    pass


def _vtbl(ptr: c_void_p, index: int, proto):
    """取 COM 接口虚表第 index 个方法的函数指针。"""
    vtable = ctypes.cast(ptr, POINTER(POINTER(c_void_p)))[0]
    return ctypes.WINFUNCTYPE(proto)(vtable[index])


def _check(hr: int, what: str) -> None:
    if hr < 0:
        raise OSError(f"{what} failed hr=0x{hr & 0xFFFFFFFF:08X}")


def decode_to_wav(src: str, dst: str, target_sr: int = 44100, channels: int = 2) -> dict:
    _check(mfplat.MFStartup(MF_VERSION, MFSTARTUP_FULL), "MFStartup")
    reader = c_void_p()
    try:
        # --- 创建源读取器 ---
        create = _vtbl_by_name(mfreadwrite, "MFCreateSourceReaderFromURL")
        create.argtypes = [LPCWSTR, c_void_p, POINTER(c_void_p)]
        create.restype = ctypes.c_long
        _check(create(src, None, byref(reader)), "MFCreateSourceReaderFromURL")
        rp = reader.value

        # --- 请求 PCM 输出 ---
        create_mt = _vtbl_by_name(mfplat, "MFCreateMediaType")
        create_mt.argtypes = [POINTER(c_void_p)]
        create_mt.restype = ctypes.c_long
        p_mt = c_void_p()
        _check(create_mt(byref(p_mt)), "MFCreateMediaType")
        mt = p_mt.value

        _vtbl(mt, 26, ctypes.c_long)  # placeholder slot guard (unused)
        set_guid = _vtbl(mt, 24, ctypes.c_long)
        set_guid = ctypes.WINFUNCTYPE(ctypes.c_long, c_void_p, POINTER(GUID), POINTER(GUID))(set_guid)
        _check(set_guid(mt, byref(MF_MT_MAJOR_TYPE), byref(MFMediaType_Audio)), "SetGUID major")
        _check(set_guid(mt, byref(MF_MT_SUBTYPE), byref(MFAudioFormat_PCM)), "SetGUID subtype")

        set_u32 = ctypes.WINFUNCTYPE(ctypes.c_long, c_void_p, POINTER(GUID), c_uint32)(_vtbl(mt, 21, ctypes.c_long))
        _check(set_u32(mt, byref(MF_MT_AUDIO_NUM_CHANNELS), channels), "SetUINT32 channels")
        _check(set_u32(mt, byref(MF_MT_AUDIO_SAMPLES_PER_SECOND), target_sr), "SetUINT32 rate")
        _check(set_u32(mt, byref(MF_MT_AUDIO_BITS_PER_SAMPLE), 16), "SetUINT32 bits")
        _check(set_u32(mt, byref(MF_MT_ALL_SAMPLES_INDEPENDENT), 1), "SetUINT32 independent")

        set_mt = ctypes.WINFUNCTYPE(ctypes.c_long, c_void_p, DWORD, c_void_p, c_void_p)(
            _vtbl(rp, 21, ctypes.c_long)  # IMFSourceReader::SetCurrentMediaType
        )
        _check(set_mt(rp, MF_SOURCE_READER_FIRST_AUDIO_STREAM, None, mt), "SetCurrentMediaType")

        # --- 读实际输出格式 ---
        get_mt = ctypes.WINFUNCTYPE(ctypes.c_long, c_void_p, DWORD, POINTER(c_void_p), POINTER(c_void_p))(
            _vtbl(rp, 20, ctypes.c_long)  # GetCurrentMediaType
        )
        p_out = c_void_p()
        _check(get_mt(rp, MF_SOURCE_READER_FIRST_AUDIO_STREAM, None, byref(p_out)), "GetCurrentMediaType")
        out_mt = p_out.value

        get_u32 = ctypes.WINFUNCTYPE(ctypes.c_long, c_void_p, POINTER(GUID), POINTER(c_uint32))(
            _vtbl(out_mt, 22, ctypes.c_long)
        )
        v_actual_sr, v_actual_ch = c_uint32(), c_uint32()
        _check(get_u32(out_mt, byref(MF_MT_AUDIO_SAMPLES_PER_SECOND), byref(v_actual_sr)), "get rate")
        _check(get_u32(out_mt, byref(MF_MT_AUDIO_NUM_CHANNELS), byref(v_actual_ch)), "get channels")

        # --- 读取样本 ---
        read_sample_fn = ctypes.WINFUNCTYPE(
            ctypes.c_long, c_void_p, DWORD, c_void_p, POINTER(c_uint32), POINTER(c_uint32), POINTER(c_void_p)
        )(_vtbl(rp, 22, ctypes.c_long))

        frames = []
        while True:
            flags = c_uint32()
            ts = ctypes.c_longlong()
            sample = c_void_p()
            hr = read_sample_fn(rp, MF_SOURCE_READER_FIRST_AUDIO_STREAM, None, byref(flags), byref(ts), byref(sample))
            _check(hr, "ReadSample")
            if flags.value & MF_SOURCE_READERF_ENDOFSTREAM:
                break
            if not sample.value:
                continue
            frames.append(_sample_bytes(sample.value))
            _release(sample.value)

        data = b"".join(frames)
        _write_wav(dst, data, v_actual_sr.value, v_actual_ch.value, 16)
        return {
            "bytes": len(data),
            "sample_rate": v_actual_sr.value,
            "channels": v_actual_ch.value,
            "frames": len(data) // (2 * max(1, v_actual_ch.value)),
            "duration_s": round(len(data) / (2 * max(1, v_actual_ch.value)) / v_actual_sr.value, 3),
        }
    finally:
        if reader.value:
            _release(reader.value)
        mfplat.MFShutdown()


def _vtbl_by_name(dll, name):
    fn = getattr(dll, name)
    return fn


def _release(ptr: int) -> None:
    ctypes.WINFUNCTYPE(ctypes.c_ulong, c_void_p)(_vtbl(ptr, 2, ctypes.c_ulong))(ptr)


def _sample_bytes(sample: int) -> bytes:
    """IMFMediaBuffer::Lock → 拷贝 → Unlock。"""
    lock = ctypes.WINFUNCTYPE(ctypes.c_long, c_void_p, POINTER(c_void_p), POINTER(c_uint32), POINTER(c_uint32))(
        _vtbl(sample, 3, ctypes.c_long)
    )
    unlock = ctypes.WINFUNCTYPE(ctypes.c_long, c_void_p)(_vtbl(sample, 4, ctypes.c_long))
    ptr = c_void_p()
    max_len = c_uint32()
    cur_len = c_uint32()
    _check(lock(sample, byref(ptr), byref(max_len), byref(cur_len)), "Lock")
    try:
        return ctypes.string_at(ptr, cur_len.value)
    finally:
        unlock(sample)


def _write_wav(path: str, data: bytes, sr: int, ch: int, bits: int) -> None:
    block = ch * bits // 8
    with open(path, "wb") as f:
        f.write(b"RIFF")
        f.write(struct.pack("<I", 36 + len(data)))
        f.write(b"WAVEfmt ")
        f.write(struct.pack("<IHHIIHH", 16, WAVE_FORMAT_PCM, ch, sr, sr * block, block, bits))
        f.write(b"data")
        f.write(struct.pack("<I", len(data)))
        f.write(data)


MF_MT_MAJOR_TYPE = GUID(0x48EBA18E, 0xF8C8, 0x11D0, 0xBF, 0x90, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71)
MF_MT_SUBTYPE = GUID(0xF7E34C9A, 0x42E8, 0x4714, 0xB4, 0xB8, 0xCB, 0x74, 0xD7, 0xE3, 0x2C, 0x0D)
MF_MT_AUDIO_NUM_CHANNELS = GUID(0x37E48BF5, 0x645E, 0x4C5B, 0x89, 0xDE, 0xAD, 0xA9, 0xE6, 0x04, 0xDB, 0x69)
MF_MT_AUDIO_SAMPLES_PER_SECOND = GUID(0x5FAEEAE7, 0x0290, 0x4C31, 0x9E, 0x8A, 0xC5, 0xA6, 0xAB, 0x78, 0x12, 0x8F)
MF_MT_AUDIO_BITS_PER_SAMPLE = GUID(0xF2DEB57F, 0x40FB, 0x4A83, 0xBC, 0xE2, 0xE2, 0x62, 0xFD, 0x4B, 0xAB, 0x70)
MF_MT_ALL_SAMPLES_INDEPENDENT = GUID(0xC9173739, 0x5E56, 0x465C, 0xB7, 0x13, 0x46, 0xFB, 0xB9, 0x97, 0xE1, 0x4F)
