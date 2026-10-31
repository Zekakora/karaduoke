#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
官方 MV 的**免配额**搜索源：ytmusicapi（https://github.com/sigma67/ytmusicapi）。

为什么需要它
------------
YouTube Data API v3 每天只有 10,000 单位，而 `search.list` 一次就要 100 单位，
批量匹配曲库（一次匹配 = 3 个搜索词 = 300 单位）很容易把配额打光，然后整天只能
用模糊专辑封面。ytmusicapi 走的是 YouTube Music 的**内部接口**（和网页版一样），
没有每日配额，而且搜索结果里直接带 `videoType`：

    MUSIC_VIDEO_TYPE_OMV  官方 MV（Official Music Video）  ← 我们要的
    MUSIC_VIDEO_TYPE_ATV  Art track（自动生成的静态封面音频，等于 Topic）
    MUSIC_VIDEO_TYPE_UGC  用户上传（翻唱 / 二创 / 现场录像）

这个 `videoType` 是官方 Data API **没有**的信号，比"标题里有没有 Official"更可靠，
所以本脚本作为**首选源**；官方 Data API 退居**兜底**（见 lib/official-mv.js）。

用法（由 lib/ytmusic.js 调用，一般不手动跑）
---------------------------------------------
    echo '{"queries":["The Weeknd Blinding Lights"],"limit":8}' | python ytmusic_mv.py

stdin  : {"queries": [...], "limit": 8}
stdout : {"ok": true, "results": {"<query>": [ {videoId,title,artists,durationSeconds,
          videoType,thumbnailUrl}, ... ]}, "errors": {"<query>": "..."} }
       失败时：{"ok": false, "code": "YTMUSIC_UNAVAILABLE", "error": "..."}

注意：**退出码永远是 0**。Node 侧靠 stdout 的 JSON 判断成败——非零退出在 Windows 上
很难区分"Python 崩了"和"脚本主动报错"，不如统一用 JSON 表达。
"""

import json
import os
import sys

# Windows 控制台默认 GBK，中文歌名直接 print 会 UnicodeEncodeError。
# 不加这行，"周杰伦 晴天" 这类查询会把整个子进程的输出打崩。
try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stdin.reconfigure(encoding='utf-8')
except Exception:  # pragma: no cover - 老版本 Python / 非 tty
    pass


def duration_to_seconds(text):
    """'4:23' → 263，'1:02:03' → 3723，解析不了返回 None。"""
    if not text:
        return None
    parts = str(text).strip().split(':')
    if not parts or len(parts) > 3:
        return None
    try:
        nums = [int(p) for p in parts]
    except ValueError:
        return None
    total = 0
    for num in nums:
        total = total * 60 + num
    return total if total > 0 else None


def pick_thumbnail(row):
    """thumbnails 是按分辨率从小到大排的数组，取最后一个（最大的）。"""
    thumbs = row.get('thumbnails') or []
    if not isinstance(thumbs, list):
        return ''
    for thumb in reversed(thumbs):
        if isinstance(thumb, dict) and thumb.get('url'):
            return thumb['url']
    return ''


def normalize(row):
    """ytmusicapi 的一条搜索结果 → 我们自己的候选形状。
    lib/official-mv.js 的评分函数直接吃这个结构。"""
    video_id = row.get('videoId')
    if not video_id:
        return None
    artists = []
    for artist in (row.get('artists') or []):
        if isinstance(artist, dict) and artist.get('name'):
            artists.append(str(artist['name']))
    return {
        'videoId': str(video_id),
        'title': str(row.get('title') or ''),
        'artists': artists,
        'durationSeconds': duration_to_seconds(row.get('duration')),
        'videoType': str(row.get('videoType') or ''),
        'thumbnailUrl': pick_thumbnail(row),
    }


def main():
    try:
        payload = json.loads(sys.stdin.read() or '{}')
    except Exception as error:
        print(json.dumps({'ok': False, 'code': 'BAD_INPUT', 'error': '输入不是合法 JSON：%s' % error},
                         ensure_ascii=False))
        return 0

    queries = [str(q).strip() for q in (payload.get('queries') or []) if str(q).strip()]
    try:
        limit = int(payload.get('limit') or 8)
    except (TypeError, ValueError):
        limit = 8
    limit = max(1, min(limit, 25))

    if not queries:
        print(json.dumps({'ok': True, 'results': {}, 'errors': {}}, ensure_ascii=False))
        return 0

    try:
        from ytmusicapi import YTMusic
    except Exception as error:
        # 没装 ytmusicapi 不算致命错误：Node 侧会记下来并自动退回官方 Data API。
        print(json.dumps({
            'ok': False,
            'code': 'YTMUSIC_UNAVAILABLE',
            'error': 'ytmusicapi 不可用（%s）。安装：env\\python\\Scripts\\python.exe -m pip install ytmusicapi' % error,
        }, ensure_ascii=False))
        return 0

    try:
        # 未登录也能搜索（只读公开接口），不需要任何凭据/浏览器 headers。
        yt = YTMusic()
    except Exception as error:
        print(json.dumps({'ok': False, 'code': 'YTMUSIC_INIT_FAILED', 'error': 'YTMusic 初始化失败：%s' % error},
                         ensure_ascii=False))
        return 0

    results = {}
    errors = {}
    for query in queries[:8]:
        try:
            rows = yt.search(query, filter='videos', limit=limit)
        except Exception as error:
            errors[query] = str(error)[:200]
            continue
        items = []
        for row in rows or []:
            item = normalize(row)
            if item:
                items.append(item)
        results[query] = items

    print(json.dumps({'ok': True, 'results': results, 'errors': errors}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    # 关掉 requests/urllib3 的代理噪声：局域网 K 歌现场不需要，报错反而刷屏。
    os.environ.setdefault('PYTHONIOENCODING', 'utf-8')
    sys.exit(main())
