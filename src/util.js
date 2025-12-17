// src/util.js
export function isVideo(filename) {
    const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v'];
    return videoExtensions.some(ext => filename.toLowerCase().endsWith(ext));
}

export function base64Encode(str) {
    return Buffer.from(str).toString('base64');
}

export function base64Decode(str) {
    return Buffer.from(str, 'base64').toString('utf8');
}

export function extractInfoHash(magnetLink) {
    const match = magnetLink.match(/btih:([a-fA-F0-9]{40})/);
    return match ? match[1].toLowerCase() : null;
}

export function detectVideoFeatures(filename) {
    const features = [];
    const fn = filename.toLowerCase();
    
    if (fn.includes('hdr')) features.push('HDR');
    if (fn.includes('dolby')) features.push('Dolby');
    if (fn.includes('atmos')) features.push('Atmos');
    if (fn.includes('x265') || fn.includes('hevc')) features.push('HEVC');
    if (fn.includes('x264')) features.push('H.264');
    
    return features;
}

export function parseQuality(filename) {
    const fn = filename.toLowerCase();
    if (fn.includes('2160') || fn.includes('4k')) return 2160;
    if (fn.includes('1080')) return 1080;
    if (fn.includes('720')) return 720;
    if (fn.includes('480')) return 480;
    return 0;
}

export function parseSize(filename) {
    const match = filename.match(/(\d+(?:\.\d+)?)\s*(GB|MB)/i);
    if (!match) return 0;
    const size = parseFloat(match[1]);
    const unit = match[2].toUpperCase();
    return unit === 'GB' ? size * 1024 : size;
}

// src/const.js
export const ERROR = {
    NOT_PREMIUM: 'NOT_PREMIUM'
};

export const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v'];

export const STREAM_SOURCES = {
    torrentio: {
        name: 'Torrentio',
        url: 'https://torrentio.strem.fun'
    }
};

// src/debridlink.js (minimal stub since you don't use it)
export class DebridLink {
    static canHandle(apiKey) {
        return false;
    }
}

// src/premiumize.js (minimal stub since you don't use it)
export class Premiumize {
    static canHandle(apiKey) {
        return false;
    }
}

// src/torbox.js (minimal stub since you don't use it)
export class TorBox {
    static canHandle(apiKey) {
        return false;
    }
}