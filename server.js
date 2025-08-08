const express = require('express');
const cors = require('cors');
const youtubedl = require('youtube-dl-exec');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs').promises;
const path = require('path');
const faceapi = require('face-api.js');
const canvas = require('canvas');
const { Canvas, Image, ImageData } = canvas;

// Optional: Improve performance with tfjs-node
try {
    require('@tensorflow/tfjs-node');
    console.log('Using @tensorflow/tfjs-node for optimized performance');
} catch (e) {
    console.log('Running without @tensorflow/tfjs-node; performance may be slower');
}

// Configure face-api.js to use canvas
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

class YouTubeShortGenerator {
    constructor() {
        this.jobs = new Map(); // Store job status
        this.outputFolder = 'generated_shorts';
        this.maxShortLength = 60; // Maximum duration for each short (seconds)
        this.minShortLength = 30; // Minimum duration for each short (seconds)
        this.shortRatio = { width: 9, height: 16 }; // Aspect ratio for Shorts
    }

    async getVideoInfo(videoUrl) {
        try {
            const info = await youtubedl(videoUrl, {
                dumpSingleJson: true,
                noWarnings: true,
                addHeader: ['User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36']
            });
            const videoId = info.id;
            const videoTitle = info.title || 'YouTube Video';
            const videoLength = info.duration || 0;
            console.log(`Video info retrieved: ID=${videoId}, Title=${videoTitle}, Length=${videoLength}s`);
            if (videoLength < this.minShortLength) {
                throw new Error(`Video is too short (must be at least ${this.minShortLength} seconds)`);
            }
            return { videoId, videoTitle, videoLength };
        } catch (error) {
            console.error(`Error getting video info: ${error.message}`);
            throw error;
        }
    }

    async downloadVideo(videoUrl, videoId) {
        try {
            await fs.mkdir(this.outputFolder, { recursive: true });
            const tempPath = path.join(this.outputFolder, `temp_${videoId}.mp4`);
            await youtubedl(videoUrl, {
                format: 'best[height<=720]',
                output: tempPath,
                addHeader: ['User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36']
            });
            return tempPath;
        } catch (error) {
            console.error(`Error downloading video: ${error.message}`);
            throw error;
        }
    }

    async analyzeEngagement(videoLength) {
        try {
            console.log('Creating fixed segments: 0-30s and 30-60s');
            const engagementData = [];
            // First segment: 0-30 seconds
            if (videoLength >= 30) {
                engagementData.push({ start: 0, end: 30, score: 80 });
            }
            // Second segment: 30-60 seconds
            if (videoLength >= 60) {
                engagementData.push({ start: 30, end: Math.min(60, videoLength), score: 80 });
            }
            if (engagementData.length === 0) {
                throw new Error('No valid segments could be created');
            }
            return engagementData;
        } catch (error) {
            console.error(`Error analyzing engagement: ${error.message}`);
            throw error;
        }
    }

    async convertToShortsFormat(inputPath, outputPath, startTime, endTime) {
        try {
            return new Promise((resolve, reject) => {
                const command = ffmpeg(inputPath)
                    .setStartTime(startTime)
                    .setDuration(endTime - startTime)
                    .videoFilters([
                        {
                            filter: 'scale',
                            options: '-1:1920', // keep height 1920, scale width proportionally
                        },
                        {
                            filter: 'crop',
                            options: '1080:1920', // crop to center for vertical format
                        },
                    ])
                    .outputOptions(['-c:v libx264', '-c:a aac', '-preset fast', '-threads 4'])
                    .on('end', () => resolve(outputPath))
                    .on('error', (err) => reject(err))
                    .save(outputPath);
            });
        } catch (error) {
            console.error(`Error converting to shorts format: ${error.message}`);
            throw error;
        }
    }

    async detectFacesInFrame(framePath) {
        try {
            const img = await canvas.loadImage(framePath);
            const detections = await faceapi.detectAllFaces(img).withFaceLandmarks();
            return detections.map(d => ({
                x: d.box.x,
                y: d.box.y,
                w: d.box.width,
                h: d.box.height,
            }));
        } catch (error) {
            console.error(`Error detecting faces: ${error.message}`);
            return [];
        }
    }

    async getSafeTextPosition(videoPath, startTime, duration) {
        try {
            const sampleTimes = Array.from(
                { length: Math.min(5, Math.floor(duration)) },
                (_, i) => startTime + (i * duration) / Math.min(5, Math.floor(duration))
            );
            const facePositions = [];
            for (const t of sampleTimes) {
                const tempFramePath = path.join(this.outputFolder, `temp_frame_${t}.jpg`);
                await new Promise((resolve, reject) => {
                    ffmpeg(videoPath)
                        .seekInput(t)
                        .frames(1)
                        .save(tempFramePath)
                        .on('end', resolve)
                        .on('error', reject);
                });
                const faces = await this.detectFacesInFrame(tempFramePath);
                const { width, height } = await new Promise((resolve) => {
                    ffmpeg.ffprobe(videoPath, (err, metadata) => {
                        if (err) return resolve({ width: 1080, height: 1920 });
                        resolve({
                            width: metadata.streams.find(s => s.codec_type === 'video').width,
                            height: metadata.streams.find(s => s.codec_type === 'video').height,
                        });
                    });
                });
                for (const face of faces) {
                    const relX = (face.x + face.w / 2) / width;
                    const relY = (face.y + face.h / 2) / height;
                    facePositions.push({ x: relX, y: relY });
                }
                await fs.unlink(tempFramePath).catch(() => {});
            }
            if (!facePositions.length) return 0.83;
            const avgY = facePositions.reduce((sum, pos) => sum + pos.y, 0) / facePositions.length;
            return Math.max(0.7, Math.min(0.9, avgY - 0.15));
        } catch (error) {
            console.error(`Error determining text position: ${error.message}`);
            return 0.83;
        }
    }

    async generateShort(videoId, videoPath, startTime, endTime, clipNum) {
        try {
            if (!await fs.access(videoPath).then(() => true).catch(() => false)) {
                throw new Error('Video file not found');
            }
            const actualStart = Math.max(0, startTime);
            let actualEnd = Math.min(endTime, this.jobs.get(videoId).videoLength);
            if (actualEnd - actualStart < this.minShortLength) {
                actualEnd = Math.min(actualStart + this.minShortLength, this.jobs.get(videoId).videoLength);
                if (actualEnd - actualStart < this.minShortLength) {
                    actualStart = Math.max(0, actualEnd - this.minShortLength);
                }
            }
            console.log(`Creating short from ${actualStart.toFixed(1)}s to ${actualEnd.toFixed(1)}s (duration: ${(actualEnd - actualStart).toFixed(1)}s)`);
            const outputPath = path.join(this.outputFolder, `short_${videoId}_${clipNum}.mp4`);
            await this.convertToShortsFormat(videoPath, outputPath, actualStart, actualEnd);
            return outputPath;
        } catch (error) {
            console.error(`Error generating short: ${error.message}`);
            throw error;
        }
    }

    async processVideo(videoUrl, jobId) {
        try {
            const { videoId, videoTitle, videoLength } = await this.getVideoInfo(videoUrl);
            this.jobs.set(jobId, {
                videoId,
                videoTitle,
                videoLength,
                status: 'downloading',
                shorts: [],
                error: null
            });

            const videoPath = await this.downloadVideo(videoUrl, videoId);
            this.jobs.set(jobId, { ...this.jobs.get(jobId), status: 'analyzing' });

            const engagementData = await this.analyzeEngagement(videoLength);
            this.jobs.set(jobId, { ...this.jobs.get(jobId), status: 'generating' });

            let successCount = 0;
            for (let i = 0; i < engagementData.length; i++) {
                const segment = engagementData[i];
                console.log(`Generating short ${i + 1} from ${segment.start.toFixed(1)}s to ${segment.end.toFixed(1)}s`);
                const outputPath = await this.generateShort(videoId, videoPath, segment.start, segment.end, i + 1);
                if (outputPath) {
                    this.jobs.get(jobId).shorts.push(outputPath);
                    successCount++;
                }
            }

            await fs.unlink(videoPath).catch(err => console.warn(`Warning: Could not remove temporary file ${videoPath}: ${err.message}`));
            this.jobs.set(jobId, {
                ...this.jobs.get(jobId),
                status: 'completed',
                successCount
            });
        } catch (error) {
            this.jobs.set(jobId, {
                ...this.jobs.get(jobId),
                status: 'failed',
                error: error.message
            });
        }
    }
}

// Initialize Express app
const app = express();
app.use(express.json());
const generator = new YouTubeShortGenerator();

// Load face-api.js models
(async () => {
    try {
        console.log('Loading face-api.js models...');
        await faceapi.nets.ssdMobilenetv1.loadFromDisk(path.join(__dirname, 'models'));
        await faceapi.nets.faceLandmark68Net.loadFromDisk(path.join(__dirname, 'models'));
        console.log('Face-api.js models loaded successfully');
    } catch (error) {
        console.error('Error loading face-api.js models:', error.message);
        console.log('Proceeding without face detection');
        generator.getSafeTextPosition = async () => 0.83; // Fallback to default position
    }
})();

// Generate a simple job ID
const generateJobId = () => {
    return 'job_' + Math.random().toString(36).substr(2, 9);
};

// Routes
app.post('/api/shorts/generate', async (req, res) => {
    const { videoUrl } = req.body;
    if (!videoUrl) {
        return res.status(400).json({ error: 'videoUrl is required' });
    }
    const match = videoUrl.match(/(?:v=|\/)([0-9A-Za-z_-]{11})/);
    if (!match) {
        return res.status(400).json({ error: 'Invalid YouTube URL' });
    }
    const jobId = generateJobId();
    generator.jobs.set(jobId, { status: 'queued' });
    // Process video in background
    generator.processVideo(videoUrl, jobId);
    res.json({ jobId, status: 'queued' });
});

app.get('/api/shorts/status/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = generator.jobs.get(jobId);
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    res.json({
        jobId,
        status: job.status,
        videoId: job.videoId,
        videoTitle: job.videoTitle,
        videoLength: job.videoLength,
        shorts: job.shorts || [],
        successCount: job.successCount || 0,
        error: job.error || null
    });
});

app.get('/api/shorts', (req, res) => {
    const jobs = Array.from(generator.jobs.entries()).map(([jobId, job]) => ({
        jobId,
        status: job.status,
        videoId: job.videoId,
        videoTitle: job.videoTitle,
        videoLength: job.videoLength,
        shorts: job.shorts || [],
        successCount: job.successCount || 0,
        error: job.error || null
    }));
    res.json(jobs);
});


app.use(cors({
  origin: 'http://localhost:5173'
}));

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`YouTube Short Generator API running on port ${PORT}`);
    console.log('Supports videos with minimum 30 second duration');
    console.log('Will create shorts for 0-30s and 30-60s');
});