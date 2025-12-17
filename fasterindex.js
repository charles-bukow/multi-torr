import { lookup } from 'node:dns/promises';
import http from 'http';
import https from 'https';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { isVideo, base64Encode, base64Decode, extractInfoHash, detectVideoFeatures, parseQuality, parseSize } from './src/util.js';
import { STREAM_SOURCES } from './src/const.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// DNS-resilient fetch to avoid ENOTFOUND errors
async function fetchWithSafeDNS(url, options = {}) {
    try {
        const { hostname } = new URL(url);
        const { address } = await lookup(hostname);
        const agent = url.startsWith('https')
            ? new https.Agent({ lookup: (_, __, cb) => cb(null, address, 4) })
            : new http.Agent({ lookup: (_, __, cb) => cb(null, address, 4) });
        return fetch(url, { ...options, agent });
    } catch (error) {
        // Fallback to regular fetch if DNS lookup fails
        return fetch(url, options);
    }
}

// Add proper timeout helper function
function fetchWithTimeout(url, options = {}, timeout = 10000) {
    return Promise.race([
        fetchWithSafeDNS(url, options),
        new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`Timeout after ${timeout}ms`)), timeout)
        )
    ]);
}

// ID type detection helper - FIXED to handle tmdb- prefix
function getIdType(id) {
    if (id.startsWith('tt')) return 'imdb';
    if (id.startsWith('tmdb-')) return 'tmdb';
    if (/^\d+$/.test(id)) return 'tmdb';
    return null;
}

// Function to get appropriate quality symbol based on quality value
function getQualitySymbol(quality) {
    const qualityStr = String(quality).toLowerCase();
    
    if (qualityStr.includes('2160') || qualityStr.includes('4k') || qualityStr.includes('uhd')) {
        return '💨'; // 4K/UHD content
    } else if (qualityStr.includes('1080')) {
        return '🎛️'; // Full HD
    } else if (qualityStr.includes('720')) {
        return '🁬'; // HD
    } else if (qualityStr.includes('480')) {
        return '⛃'; // SD
    } else if (qualityStr.includes('cam') || qualityStr.includes('hdts')) {
        return '🎲'; // CAM/TS quality
    } else {
        return '🃠'; // Default/unknown quality
    }
}

function sortStreams(streams) {
    return streams.sort((a, b) => {
        // Parse quality and size from stream names
        const qualityA = parseQuality(a.name);
        const qualityB = parseQuality(b.name);
        const sizeA = parseSize(a.name);
        const sizeB = parseSize(b.name);

        // Group by quality first
        if (qualityA !== qualityB) {
            return qualityB - qualityA; // Higher quality first
        }

        // If same quality, prefer reasonable file sizes
        const idealSizeRanges = {
            2160: { min: 10000, max: 80000 },   // 10GB - 80GB for 4K
            1080: { min: 2000, max: 16000 },    // 2GB - 16GB for 1080p
            720: { min: 1000, max: 8000 },      // 1GB - 8GB for 720p
            480: { min: 500, max: 4000 }        // 500MB - 4GB for 480p
        };

        const idealRange = idealSizeRanges[qualityA] || { min: 0, max: Infinity };

        const getIdealScore = (size, range) => {
            if (size >= range.min && size <= range.max) return 0;
            if (size < range.min) return range.min - size;
            return size - range.max;
        };

        const scoreA = getIdealScore(sizeA, idealRange);
        const scoreB = getIdealScore(sizeB, idealRange);

        if (scoreA !== scoreB) {
            return scoreA - scoreB;
        }

        return sizeB - sizeA;
    });
}

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

app.use(express.static(path.join(__dirname, 'public')));
app.options('*', cors());

// Root manifest endpoint - for scraper backend
app.get('/manifest.json', (req, res) => {
    const manifest = {
        id: 'org.magnetio.raw',
        version: '1.0.0',
        name: 'HYIO Raw Torrents',
        description: 'Stream movies and series via raw magnet links - Scraper backend for CF Worker',
        resources: ['stream'],
        types: ['movie', 'series'],
        idPrefixes: ['tt', 'tmdb'],
        catalogs: [],
        behaviorHints: {
            adult: true
        }
    };
    res.json(manifest);
});

async function getStreams(type, id, season = null, episode = null) {
    try {
        console.log('\n🔄 Fetching streams from APIs');
        
        let query;
        const idType = getIdType(id);
        if (!idType) {
            console.error('Invalid ID format:', id);
            return [];
        }

        // Extract actual ID from tmdb-XXXXX format
        let actualId = id;
        if (id.startsWith('tmdb-')) {
            actualId = id.replace('tmdb-', '');
        }

        if (type === 'series') {
            if (!season || !episode) throw new Error('Season and episode required for series');
            query = `${actualId}:${season}:${episode}`;
        } else {
            query = actualId;
        }

        // Fetch from all APIs concurrently with proper timeout
        const fetchPromises = Object.values(STREAM_SOURCES).map(async (source) => {
            try {
                const apiUrl = `${source.url}/api/search?type=${type}&query=${encodeURIComponent(query)}`;
                console.log(`Fetching from ${source.name}:`, apiUrl);
                
                const response = await fetchWithTimeout(apiUrl, { 
                    headers: { 'User-Agent': 'Stremio-Raw-Torrents/1.0' }
                }, 10000); // 10 second timeout per API
                
                if (!response.ok) {
                    console.error(`API response not ok from ${source.name}:`, response.status);
                    return [];
                }
                
                const data = await response.json();
                if (!data?.results?.length) {
                    console.log(`No results found from ${source.name}`);
                    return [];
                }

                console.log(`Found ${data.results.length} results from ${source.name}`);
                
                return data.results.map(result => ({
                    ...result,
                    source: source.name
                }));
            } catch (error) {
                console.error(`Error fetching from ${source.name}:`, error);
                return [];
            }
        });

        const allResults = await Promise.all(fetchPromises);
        
        // Combine and deduplicate results
        const seenMagnets = new Set();
        let combinedResults = allResults
            .flat()
            .reduce((unique, stream) => {
                try {
                    if (!stream?.magnetLink) return unique;

                    const hash = stream.magnetLink.match(/btih:([a-f0-9]+)/i)?.[1]?.toLowerCase();
                    if (!hash || seenMagnets.has(hash)) return unique;
                    seenMagnets.add(hash);

                    const quality = stream.quality || 
                                  stream.title?.match(/\d{3,4}p|4k|uhd|HDTS|CAM/i)?.[0] || '';
                    
                    const size = stream.size || 
                               stream.title?.match(/\d+(\.\d+)?\s*(GB|MB)/i)?.[0] || '';

                    const filename = stream.filename || stream.title?.split('\n')[0]?.trim() || 'Unknown';
                    
                    unique.push({
                        hash,
                        magnetLink: stream.magnetLink,
                        filename,
                        websiteTitle: stream.title || filename,
                        quality,
                        size,
                        source: stream.source || 'Unknown'
                    });

                    return unique;
                } catch (error) {
                    console.error('Error processing stream:', error);
                    return unique;
                }
            }, []);

        // CRITICAL: Filter for specific episode if series
        if (type === 'series' && season && episode) {
            const seasonNum = parseInt(season);
            const episodeNum = parseInt(episode);
            
            combinedResults = combinedResults.filter(stream => {
                const title = (stream.filename || stream.websiteTitle || '').toLowerCase();
                
                // Check for SxxExx format
                const sxxexx = title.match(/s(\d{1,2})e(\d{1,2})/i);
                if (sxxexx) {
                    return parseInt(sxxexx[1]) === seasonNum && parseInt(sxxexx[2]) === episodeNum;
                }
                
                // Check for individual S and E patterns
                const seasonMatches = title.match(/s(\d{1,2})/gi) || [];
                const episodeMatches = title.match(/e(\d{1,2})/gi) || [];
                
                const seasons = seasonMatches.map(match => parseInt(match.replace(/s/i, '')));
                const episodes = episodeMatches.map(match => parseInt(match.replace(/e/i, '')));
                
                return seasons.includes(seasonNum) && 
                       episodes.includes(episodeNum) &&
                       seasons.length === 1 && 
                       episodes.length === 1;
            });
            
            console.log(`Filtered to ${combinedResults.length} streams matching S${season}E${episode}`);
        }

        console.log(`Found ${combinedResults.length} unique streams from all sources`);
        return combinedResults;
    } catch (error) {
        console.error('❌ Error fetching streams:', error);
        return [];
    }
}

// Raw torrent stream endpoint - OPTIMIZED FOR CF WORKER CONSUMPTION
app.get('/stream/:type/:id.json', async (req, res) => {
    const { type, id } = req.params;
    
    try {
        let tmdbId = id;
        let season = null;
        let episode = null;

        // Handle series ID format
        if (type === 'series') {
            [tmdbId, season, episode] = id.split(':');
        }

        const idType = getIdType(tmdbId);
        if (!idType) {
            console.error('Invalid ID format:', tmdbId);
            return res.json({ streams: [] });
        }

        console.log(`Processing ${idType.toUpperCase()} ID: ${tmdbId}`);

        // Fetch streams directly from APIs
        const streams = await getStreams(type, tmdbId, season, episode);
        
        if (!streams.length) {
            console.log('No streams found');
            return res.json({ streams: [] });
        }
        
        console.log(`Found ${streams.length} streams from sources`);
        
        // Format streams for CF Worker consumption
        const formattedStreams = streams.map(stream => {
            try {
                // Get video features
                const features = detectVideoFeatures(stream.filename);
                const featureStr = features.length ? features.join(' | ') : '';
                
                // Format quality display (keep as STRING for CF Worker)
                const qualityDisplay = stream.quality ? stream.quality.toUpperCase() : '';
                
                // Get quality symbol
                const qualitySymbol = getQualitySymbol(qualityDisplay || stream.filename);
                
                // Format the stream name (CF Worker will parse this)
                const streamName = [
                    qualitySymbol,
                    qualityDisplay, 
                    stream.size,
                    stream.source
                ].filter(Boolean).join(' | ');
                
                // Create detailed title
                const streamTitle = [
                    stream.filename,
                    [
                        `☠︎ ${stream.source}`,
                        featureStr
                    ].filter(Boolean).join(' | ')
                ].filter(Boolean).join('\n');
                
                // Return format compatible with CF Worker's expectations
                return {
                    name: streamName,           // CF Worker uses this
                    title: streamTitle,          // CF Worker uses this
                    url: stream.magnetLink,      // CF Worker needs magnet link
                    infoHash: stream.hash,       // CF Worker uses for deduplication
                    behaviorHints: {
                        notWebReady: true        // CF Worker preserves this
                    }
                };
                
            } catch (error) {
                console.error(`Error formatting stream:`, error);
                return null;
            }
        }).filter(Boolean);
        
        // Sort streams by quality (best first for CF Worker to process)
        const sortedStreams = sortStreams(formattedStreams)
            .slice(0, 50); // Limit to top 50 to avoid overloading CF Worker
        
        console.log(`\n✅ Sending ${sortedStreams.length} streams to CF Worker`);
        res.json({ streams: sortedStreams });

    } catch (error) {
        console.error('❌ Error processing streams:', error);
        res.json({ streams: [] });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        service: 'HYIO Scraper Backend',
        version: '1.0.0',
        sources: Object.values(STREAM_SOURCES).map(s => s.name),
        timestamp: new Date().toISOString()
    });
});

const port = process.env.PORT || 80;
app.listen(port, () => console.log(`\n🚀 Scraper Backend running at http://localhost:${port}`));
