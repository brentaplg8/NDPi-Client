const { EventEmitter } = require('node:events');
const { spawn, exec } = require('node:child_process');
const path = require('path');
const func = require('./functions');

class NDI_Receiver_v4 extends EventEmitter {
    constructor(
        fsData,
        api,
        libraryPath = '',
        xAuthority = ''
    ) {
        super();

        this.settings = fsData;
        this.server = api;
        this.displayActivated = String(this.settings.get('output_display_cec_status_power') || 'unknown').toLowerCase() === 'on';

        this.receiverDirectory = path.join(__dirname, '..', 'ndi_receiver_v3__NDI6');

        this.reconnectTimer = null;

        this.receiver = null;

        this.receiverName = this.settings.get('ndi_receiver_exec');
        this.libraryPath = libraryPath || `${this.receiverDirectory}/lib/aarch64-rpi4-linux-gnueabi:${process.env.LD_LIBRARY_PATH}`;
        this.xAuth = xAuthority || `${process.env.HOME}/.Xauthority`;

        this.ndiSource = this.settings.get('ndpi_status_ndi_source_target') || 'none';

        fsData.on('device_volume', async (data) => {
            if (this.receiver)
            {
                this.volumeSetPoint = Number(data || '255');
                await func.fadeVolume(this.volumeSetPoint, 'Auto-Adjust NDI Receiver');
            }
        });
        this.volumeSetPoint = Number(this.settings.get('device_volume') || '255');

        fsData.on('ndi_receiver_bandwidth', async (data) => {
            if (this.receiver)
            { await func.exe(`killall -s SIGKILL ${this.receiverName}`); }

            this.ndiBandwidth = String(data || '').trim() || '0';
            this.ndiSource = this.settings.get('ndpi_status_ndi_source_target') || 'none';

            if (this.receiver)
            {
                await func.wait(1000);
                this.connect();
            }
        });
        this.ndiBandwidth = this.settings.get('ndi_receiver_bandwidth') || '0';
            // -10 = metadata_only -> Receive metadata.
            //  10 = audio_only    -> Receive metadata, audio.
            //   0 = lowest        -> Receive metadata, audio, video at a lower bandwidth and resolution.
            // 100 = highest       -> Receive metadata, audio, video at full resolution.
            // 0x7fffffff = max
        

        fsData.on('ndi_receiver_color_format', async (data) => {
            if (this.receiver)
            { await func.exe(`killall -s SIGKILL ${this.receiverName}`); }

            this.ndiColorFormat = String(data || '').trim() || '100';
            this.ndiSource = this.settings.get('ndpi_status_ndi_source_target') || 'none';

            if (this.receiver)
            {
                await func.wait(1000);
                this.connect();
            }
        });
        this.ndiColorFormat = this.settings.get('ndi_receiver_color_format') || '100';
            //   0 = BGRX_BGRA
            //   1 = UYVY_BGRA
            //   2 = RGBX_RGBA
            //   3 = UYVY_RGBA
            // 100 = fastest  
            // 101 = best     

        fsData.on('ndi_receiver_scale_method', async (data) => {
            if (this.receiver)
            { await func.exe(`killall -s SIGKILL ${this.receiverName}`); }

            this.ndiScaleMethod = String(data || '').trim() || 'bilinear';
            this.ndiSource = this.settings.get('ndpi_status_ndi_source_target') || 'none';

            if (this.receiver)
            {
                await func.wait(1000);
                this.connect();
            }
        });
        this.ndiScaleMethod = this.settings.get('ndi_receiver_scale_method') || 'bilinear';
        
        this.ndiActiveSource = null;
        this.ndiConnectedAt = null;
        this.ndiFramerate = null;
        this.ndiResolution = null;
        this.ndiStatus = 'idle';
        this.windowId = null;

        this.enabled = true;
        this.closing = false;
        this.secondsInactive = 0;

        if (this.ndiSource.toLowerCase() !== 'none')
        { this.connect(); }
        else
        {
            this.settings.put('ndpi_status_ndi_status', 'idle');
            this.settings.put('ndpi_status_ndi_source_active', '');
            this.settings.put('ndpi_status_ndi_source_connected_time', '');
            this.settings.put('ndpi_status_ndi_source_framerate', '');
            this.settings.put('ndpi_status_ndi_source_resolution', '');
            process.nextTick(() => { this.emit('close'); });
        }
    }

    async connect() {
        if (this.ndiSource.toLowerCase() === 'none')
        {
            this.settings.put('ndpi_status_ndi_status', 'idle');
            this.settings.put('ndpi_status_ndi_source_active', '');
            this.settings.put('ndpi_status_ndi_source_connected_time', '');
            this.settings.put('ndpi_status_ndi_source_framerate', '');
            this.settings.put('ndpi_status_ndi_source_resolution', '');
            process.nextTick(() => { this.emit('close'); });
            return;
        }

        this.receiver = spawn(`./${this.receiverName}`, [
            '--source',       this.ndiSource,
            '--bandwidth',    this.ndiBandwidth,
            '--color-format', this.ndiColorFormat,
            '--scale-method', this.ndiScaleMethod,
            //'--framesync'
        ], {
            cwd: this.receiverDirectory,
            env: {
                ...process.env,
                DISPLAY: ':0',
                XAUTHORITY: this.xAuth,
                LD_LIBRARY_PATH: this.libraryPath
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        this.receiver.once('spawn', () => {
            this.settings.put('pid_ndi_player', String(this.receiver.pid || ''));
        });

        this.receiver.stdout.on('data', (data) => {
            this._handleReceiverData(data.toString().trim());
        });

        this.receiver.stderr.on('data', (data) => {
            if (!this.receiver.signalCode)
            {
                func.stdoutToArray(data.toString().trim()).forEach((line) => {
                    console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ] -`, line);
                });
            }
        });

        this.receiver.on('error', (error) => {
            console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ RECEIVER ERROR ] -`, error);
            this.emit('error');
        });

        this.receiver.once('exit', async (code, signal) => {
            this.ndiActiveSource = null;
            this.ndiStatus = 'idle';
            this.ndiConnectedAt = null;
            this.ndiFramerate = null;
            this.ndiResolution = null;

            await Promise.all([
                new Promise((resolve) => {
                    const startTimeout = setTimeout(() => { resolve(); }, 2000);
                    this.settings.once('ndpi_status_ndi_source_active', () => {
                        clearTimeout(startTimeout);
                        resolve();
                    });
                    this.settings.put('ndpi_status_ndi_source_active', '');
                }),
                new Promise((resolve) => {
                    this.settings.once('ndpi_status_ndi_status', () => {
                        resolve();
                    });
                    this.settings.put('ndpi_status_ndi_status', this.ndiStatus);
                }),
                new Promise((resolve) => {
                    const startTimeout = setTimeout(() => { resolve(); }, 2000);
                    this.settings.once('ndpi_status_ndi_source_connected_time', () => {
                        clearTimeout(startTimeout);
                        resolve();
                    });
                    this.settings.put('ndpi_status_ndi_source_connected_time', '');
                }),
                new Promise((resolve) => {
                    const startTimeout = setTimeout(() => { resolve(); }, 2000);
                    this.settings.once('ndpi_status_ndi_source_framerate', () => {
                        clearTimeout(startTimeout);
                        resolve();
                    });
                    this.settings.put('ndpi_status_ndi_source_framerate', '');
                }),
                new Promise((resolve) => {
                    const startTimeout = setTimeout(() => { resolve(); }, 2000);
                    this.settings.once('ndpi_status_ndi_source_resolution', () => {
                        clearTimeout(startTimeout);
                        resolve();
                    });
                    this.settings.put('ndpi_status_ndi_source_resolution', '');
                }),
                new Promise((resolve) => {
                    const startTimeout = setTimeout(() => { resolve(); }, 2000);
                    this.settings.once('pid_ndi_player', () => {
                        clearTimeout(startTimeout);
                        resolve();
                    });
                    this.settings.put('pid_ndi_player', '');
                }),
            ]);

            this.receiver = null;

            if (signal == 'SIGKILL') { this.emit('killed'); }
        });
    }

    /**
     * Handle data from 'receiver.stdout.on('data')'
     * @param {string} stdout ⚠️ CONVERT TO STRING FIRST〈 data.toString().trim() 〉
     */
    _handleReceiverData(stdout) {
        if (stdout.includes('NDI Receiver started:'))
        {
            this.logInfo(stdout);
            this.secondsInactive = 0;
            this.ndiConnectedAt = new Date().toISOString();
            this.ndiActiveSource = this.ndiSource;
            this.ndiStatus = 'streaming';

            this.settings.put('ndpi_status_ndi_status', this.ndiStatus);
            this.settings.put('ndpi_status_ndi_source_active', this.ndiActiveSource || '');
            this.settings.put('ndpi_status_ndi_source_connected_time', this.ndiConnectedAt || '');

            this.showGStreamer(2000);
        }
        else if (stdout.includes('Reconnected to:'))
        {
            this.ndiStatus = 'streaming';
            this.settings.put('ndpi_status_ndi_status', this.ndiStatus);

            if (this.secondsInactive >= 60)
            { this.showGStreamer(); }

            if (this.secondsInactive >= 2)
            { this.logInfo(stdout); }

            this.secondsInactive = 0;
        }
        else
        { this.logInfo(stdout); }
    }

    async showGStreamer(delay = 1000) {
        if (!this.displayActivated)
        {
            this.displayActivated = true;
            await func.activateDisplay();
        }

        await func.wait(delay);

        // func.fadeVolume(this.volumeSetPoint, `${path.basename(__filename)} connect(); stdout.on(data)`);

        await Promise.all([
            func.fadeVolume(this.volumeSetPoint, `${path.basename(__filename)} connect(); stdout.on(data)`),
            func.activateWindow_NDI().catch(),
            func.minimizeWindow_Chromium().catch()
        ]);
        // const step1 = func.activateWindow_NDI();

        // const step2 = func.minimizeWindow_Chromium();
        // if (!step2)
        // { console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ][ >> Step 1: Minimize Chromium ]`); }
        
        // await func.wait(1000); // not affected by the delay argv.
        // if (!step1)
        // { console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ][ >> Step 2: Activate GStreamer ]`); return; }

        /*
        setTimeout(() => {
            func.killPicom();
        }, 1000); // not affected by the delay argv.
        */
    }

    /**
     * ---
     * 
     * **_Step 1 of 2_** ⎯ Call this function before terminating the NDI® Receiver
     * 
     * **1.1** ⎯ Fade Volume to _0_
     * 
     * **1.2** ⎯ Minimize GStreamer
     * 
     * **@async**
     * 
     */
    async showChromium_PreTerm() {
        await Promise.all([
            func.fadeVolume(0, `${path.basename(__filename)} softClose()`).catch(),
            func.minimizeWindow_NDI().catch()
        ]);
        return;
    }

    /**
     * ---
     * 
     * **_Step 2 of 2_** ⎯ Call this function after terminating the NDI® Receiver
     * 
     * **2.1** ⎯ Raise Window **Chromium**
     * 
     * **2.2** ⎯ Activate Window **Chromium**
     * 
     * **2.3** ⎯ Launch Picom (Default: false)
     * 
     * **@async**
     * 
     * @param {boolean} picom >**picom**: Launch Picom? (Default: false)
     */
    async showChromium_PostTerm(picom = false) {
        await func.raiseWindow_Chromium().catch();
        // if (picom) { await func.launchPicom(); }
        await func.wait(500);
        await func.activateWindow_Chromium().catch();
        return;
    }

    /**
     * @async
     * Kill the NDI Receiver without resetting the target source.
     * To reactivate the source, call 'thisModule.connect();'
     */
    async softClose() {
        await this.showChromium_PreTerm();

        if (this.receiver)
        {
            await new Promise(async (resolve) => {
                this.receiver.once('exit', () => { resolve(); });
                await func.exe(`killall ${this.receiverName}`);
            });
            this.receiver = null;
        }
        
        await this.showChromium_PostTerm(false);
    }
    
    /**
     * @async
     * Kill the NDI Receiver and close out of the module.
     */
    async close() {
        this.enabled = false;
        
        await this.showChromium_PreTerm()

        if (this.receiver)
        {
            await new Promise((resolve) => {
                if (this.receiver?.exitCode !== null || this.receiver?.killed) {
                    resolve();
                    return;
                }

                this.receiver.once('exit', (code, signal) => {
                    console.info(`[ -CLOSED ][ ${path.basename(__filename).split('.')[0]} ]`);
                    resolve();
                    return;
                });

                try 
                {
                    console.info(`[ CLOSING ][ ${path.basename(__filename).split('.')[0]} ]`);
                    this.receiver.kill('SIGKILL');
                }
                catch
                { 
                    if (!this.receiver.killed)
                    { this.receiver.kill('SIGKILL'); }
                }

            });
        }

        await this.showChromium_PostTerm(true);
        this.emit('close');
    }

    logInfo(data) {
        const log = (line = '') => {
            console.info(`[ ${path.basename(__filename).split('.')[0]} ][ NDI® ] → ${line}`);
        }
        data.split(/\r?\n/).forEach((stdout) => {
            const str = String(stdout || '');

            if (str && !str.startsWith('- '))
            {
                const KeyValues = str.split('^');
                switch(KeyValues[0])
                {
                    case 'Display_Resolution':
                        log(`${KeyValues[0]} = ${KeyValues[1]}`);
                        break;
                    case 'NDI_Source_Compression':
                        log(`${KeyValues[0]} = ${KeyValues[1]}`);
                        break;
                    case 'NDI_Source_Resolution':
                        log(`${KeyValues[0]} = ${KeyValues[1]}`);
                        this.ndiResolution = KeyValues[1];
                        this.settings.put('ndpi_status_ndi_source_resolution', this.ndiResolution || '');
                        break;
                    case 'NDI_Source_Framerate':
                        log(`${KeyValues[0]} = ${KeyValues[1]}`);
                        this.ndiFramerate = KeyValues[1];
                        this.settings.put('ndpi_status_ndi_source_framerate', String(this.ndiFramerate || ''));
                        break;
                    case 'NDI_Source_Not_Active':
                        if (this.ndiSource !== 'none')
                        {
                            this.secondsInactive++;
                            this.processInactiveStream();
                        }
                        break;
                    case 'Scaled_Output_Resolution':
                        log(`${KeyValues[0]} = ${KeyValues[1]}`);
                        break;
                    case 'WebKit_Overlay':
                        log(`${KeyValues[0]} = ${KeyValues[1]}`);
                        break;
                    case 'WebKit_Source_URI':
                        log(`${KeyValues[0]} = ${KeyValues[1]}`);
                        break;
                    default:
                        //
                        break;
                }
            }
            else
            { log(stdout); }
        });
    }

    async processInactiveStream() {
        switch(this.secondsInactive)
        {
            case 2:
                this.settings.put('ndpi_status_ndi_status', 'stalled');
                return;
                break;
            case 10:
                console.info(`[ ${path.basename(__filename).split('.')[0]} ] ${this.ndiSource} inactive for ${this.secondsInactive} seconds.`);
                return;
                break;
            case 20:
                console.info(`[ ${path.basename(__filename).split('.')[0]} ] ${this.ndiSource} inactive for ${this.secondsInactive} seconds.`);
                return;
                break;
            case 30:
                console.info(`[ ${path.basename(__filename).split('.')[0]} ] ${this.ndiSource} inactive for ${this.secondsInactive} seconds.`);
                return;
                break;
            case 40:
                console.info(`[ ${path.basename(__filename).split('.')[0]} ] ${this.ndiSource} inactive for ${this.secondsInactive} seconds.`);
                return;
                break;
            case 50:
                console.info(`[ ${path.basename(__filename).split('.')[0]} ] ${this.ndiSource} inactive for ${this.secondsInactive} seconds.`);
                return;
                break;
            case 60:
                console.info(`[ ${path.basename(__filename).split('.')[0]} ] ${this.ndiSource} inactive for ${this.secondsInactive} seconds.`);
                // await func.launchPicom();
                // await func.wait(1000);
                await this.showChromium_PreTerm();
                await this.showChromium_PostTerm(false);
                return;
                break;
            default:
                if (this.secondsInactive === 61)
                { console.info(`[ ${path.basename(__filename).split('.')[0]} ] ${this.ndiSource} inactive longer than 60 seconds. Awaiting reconnection.`); }
                return;
                break;
        }
    }
}

module.exports = NDI_Receiver_v4;