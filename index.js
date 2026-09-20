const fs = require('fs');
const path = require('path');
const func = require('./service/functions.js');
const { exec, spawn } = require('node:child_process');
const { exit } = require('node:process');

const VERSION_DIR = path.join(__dirname, 'version');
const NDPi_VERSION = (
    fs.existsSync(`${VERSION_DIR}/current`) ?
    fs.readFileSync(`${VERSION_DIR}/current`, 'utf8') :
    '3.1.0'
);
const NDPi_VERSION_DATE = (
    fs.existsSync(`${VERSION_DIR}/current-date`) ?
    fs.readFileSync(`${VERSION_DIR}/current-date`, 'utf8') :
    '2026-02-04'
);

class NDPi {
    constructor() {
        this.isInitialized = false;

        this.settings = null;
        this.server_api = null;
        this.service_bonjour = null;
        this.service_chromium = null;
        this.controller_cec = null;
        this.ndiReceiver = null;
        this.lcdDisplayRestartTimer = null;
        this.lcdDisplay = null;
        this.timerRestartNdi = null;
        this.targetSource = 'none';
        this.shutdown = false;
        this.airPlay = null;

        this.initiate();
    }

    /** INITIATE */
    initiate() {
        const execStartup = async () => {
            const startup = exec(`./sh/startup`);
            startup.stdout.on('data', (data) => {
                data
                    .toString()
                    .split(/\r?\n/)
                    .forEach((line) => { console.info(line) });
            });
            startup.once('exit', () => {
                console.info(process.env);
                this.startFsData();
            });
        };
        execStartup();
    }

    /**
     * START FILE SYSTEM WATCHER
     */
    startFsData() {
        this.settings = new (require('./service/client_fs.js'))(NDPi_VERSION, NDPi_VERSION_DATE);

        //  FS System Ready
        this.settings.on('ready', () => {
            this.targetSource = this.settings.get('ndpi_status_ndi_source_target') || 'none';
            func.setDisplayResolution();
            this.startAirPlay();
            // this.startLcdDisplay();
            this.startMdns();
            this.startApi();
        });

        //  NDI Source Target
        this.settings.on('ndpi_status_ndi_source_target', (data) => {
            const output = String(data || 'none');
            this.startNdiReceiver(output);
        });

        //  Device Name
        this.settings.on('device_name', (data) => {
            const output = String(data.toString().trim() || '') || null;
            if (!output)
            {
                fs.writeFileSync(path.join(process.env.DATA_NDPI_PATH, 'device_name'), this.settings.defaultDeviceName, 'utf8');
                return;
            }

            if (this.controller_cec)
            { this.controller_cec.updateDeviceName(output); }

            this.restartAirPlay();
        });

        //  Device IP
        this.settings.on('device_ip', (data) => {
            const output = String(data || '').trim() || null;
            if (!output)
            { return; }
        });

        //  API Port Number
        this.settings.on('local_port_number_api', async (data) => {
            const output = String(data || '').trim() || null;

            if (!output) { return; }

            if (this.service_chromium) { await this.service_chromium.close(); }
            if (this.server_api) { this.server_api.close(); }

            console.info(`[ ${path.basename(__filename).split('.')[0]} ] Updated API Server PORT.`);
            console.info(`[ ${path.basename(__filename).split('.')[0]} ] Restarting API Server.`);

            setTimeout(() => {
                this.startApi();
            }, 1000);
        });

        //  HDMI Port
        this.settings.on('output_display_port', async (data) => {
            const output = String(data || '').trim() || null;
            if (output) { await func.setDisplayResolution(); }
        });

        //  HDMI Resolution
        this.settings.on('output_display_resolution_preference', (data) => {
            func.setDisplayResolution();
        });

        //  ApirPlay PIN
        this.settings.on('ndpi_airplay_server_pin', () => {
            this.restartAirPlay();
        });
    }

    async _closeFsData() {
        return new Promise(async (resolve) => {
            if (this.settings)
            {
                await this.settings.close();
                resolve();
            }
            else
            {
                console.error(`FsData wasn't running...`, this.settings);
                resolve();
            }
        });
    }

    /**
     * START APPLE AIRPLAY SERVER
     */
    startAirPlay() {
        const name = this.settings.get('device_name');
        const pin = this.settings.get('ndpi_airplay_server_pin') || null;

        let airPlayOptions = ['-n', name, '-nh', '-fs', '-hls', '-fps', '60', '-d' ];
        if (pin && /^\d{1,4}$/.test(pin))  // Validate PIN.
        {
            airPlayOptions.push('-pin');
            airPlayOptions.push(String(pin).padStart(4, '0')); // Pad PIN with '0' (e.g. pin = '45' >> '0045')
        }

        this.airPlay = spawn('uxplay', airPlayOptions, { env: { ...process.env } });

        this.airPlay.once('spawn', () => {
            this.settings.put('pid_air_play_player', String(this.airPlay.pid || ''));
        });

        this.airPlay.once('exit', () => {
            this.settings.put('pid_air_play_player', '');
        });

        this.airPlay.stdout.on('data', (data) => {
            func.stdoutToArray(data.toString().trim()).forEach((line) => {
                if (String(line || '').includes('Open connections:'))
                {
                    console.log(`[ ${path.basename(__filename).split('.')[0]} ][ AirPlay ]`, line);
                }
                else if (String(line || '').includes('Begin streaming to GStreamer video pipeline'))
                {
                    // console.log(`[ ${path.basename(__filename).split('.')[0]} ][ AirPlay ]`, line);
                    console.log('');
                }
                else if (String(line || '').includes('*** X11 Windows:'))
                {
                    console.info(`[ ${path.basename(__filename).split('.')[0]} ][ AirPlay ]`, `Starting AirPlay`);
                    func.activateWindow_AirPlay();
                    func.fadeVolume(Number(this.settings.get('device_volume') || '255'), 'Fade-in AirPlay Receiver Start');
                }
            });
        });
        
        this.airPlay.stderr.on('data', (data) => {
            func.stdoutToArray(data.toString().trim()).forEach((line) => {
                console.log('⚠️   [ index ][ AirPlay ][ ERROR ]', line);
            });
        });

        this.airPlay.on('message', (m) => {
            console.log('✉️   [ index ][ AirPlay ][ onMessage ]', m);
        });
        
        this.airPlay.on('error', (err) => {
            console.log('⚠️   [ index ][ AirPlay ][ onError ]', err);
        });
    }

    async restartAirPlay() {
        if (this.airPlay)
        {
            await new Promise((resolve) => {
                this.airPlay.once('close', () => {
                    setTimeout(() => {
                        resolve();
                    }, 2000);
                });
                this.airPlay.kill('SIGINT');
            });
            this.airPlay = null;
        }
        this.startAirPlay();
    }

    /**
     * LAUNCH LCD DISPLAY RENDERER
     */
    async startLcdDisplay() {
        if (this.lcdDisplay)
        {
            await this._closeLcdDisplay();
            await func.wait(500);
        }

        this.lcdDisplay = spawn('python', ['lcdDisplayUpdate.py'], {
            env: { ...process.env }
        });

        this.lcdDisplay.on('spawn', () => {
            this.lcdDisplayRestartTimer = setTimeout(() => {
                this.lcdDisplayRestartTimer = null;
                this.startLcdDisplay();
            }, (60 * 60) * 1000);
        });

        this.lcdDisplay.stderr.on('data', (data) => {
            console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ update_lcd ][ ERROR ]`, data.toString());
        });

        this.lcdDisplay.on('error', (err) => {
            console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ update_lcd ][ ERROR ]`, err);
        });

        this.lcdDisplay.once('close', (code, signal) => {
            console.info(`[ ${path.basename(__filename).split('.')[0]} ][ update_lcd ] Closed`);
        });
    }

    async _closeLcdDisplay () {
        console.log('*** SHUTDOWN ⎯ 4 (1 of 2) [ Start [_closeLcdDisplay] ]');
        return new Promise((resolve) => {
            if (!this.lcdDisplay.exitCode)
            {
                this.lcdDisplay.once('exit', () => {
                    console.log('*** SHUTDOWN ⎯ 4 (2 of 2) [ End   [_closeLcdDisplay]: A ]');
                    resolve();
                })
                this.lcdDisplay.kill('SIGTERM');
            }
            else
            {
                console.log('*** SHUTDOWN ⎯ 4 (2 of 2) [ End   [_closeLcdDisplay]: B ]');
                resolve();
            }
        });
    }

    /**
     * START API
     */
    startApi() {
        this.server_api = new (require('./service/client_api_server.js'))(this.settings);

        this.server_api.on('online', () => {
            if (!this.isInitialized)
            {
                this.isInitialized = true;
                this.openCecController();
                this.startChromium();
            }
            else 
            { this.startChromium(); }
        });

        this.server_api.on('shutdown-command', () => {
            setTimeout(() => { shutdownDevice(); }, 5000);
        });

        this.server_api.on('reboot-command', () => {
            setTimeout(() => { rebootDevice(); }, 5000);
        });
    }

    async _closeApi() {
        if (this.server_api)
        {
            console.log('*** SHUTDOWN ⎯ 8 (1 of 2) [ Start [_closeApi] ]');
            await new Promise((resolve) => {
                this.server_api.close().catch().finally(() => { resolve(); });
            });
            // await this.server_api.close();
            console.log('*** SHUTDOWN ⎯ 8 (2 of 2) [ End   [_closeApi] ]');
            this.server_api = null;
        }
    }

    /**
     * START BONJOUR MDNS BROADCAST
     */
    startMdns() {
        const NDPiBonjourService = require('./service/client_bonjour.js');
        this.service_bonjour = new (require('./service/client_bonjour.js'))(this.settings);
    }

    async _closeMdns() {
        if (this.service_bonjour)
        {
            console.log('*** SHUTDOWN ⎯ 6 (1 of 2) [ Start [_closeMdns] ]');
            await this.service_bonjour.close();
            console.log('*** SHUTDOWN ⎯ 6 (2 of 2) [ End   [_closeMdns] ]');
            this.service_bonjour = null;
        }
    }

    /**
     * LAUNCH LOCAL CHROMIUM DISPLAY
     */
    async startChromium() {
        if (fs.existsSync('/usr/bin/chromium'))
        {
            if (this.service_chromium)
            { await this.service_chromium.close(); }

            // const ChromiumOverlayDisplay = require('./service/client_chromium.js');
            this.service_chromium = new (require('./service/client_chromium.js'))(this.settings, this.server_api);

            this.service_chromium.on('ready', () => {
                setTimeout(() => { this._afterChromiumStart(); }, 1000);
            });
        }
        else
        {
            console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ client_chromium ] Skipping Chromium display launch.`);
            console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ client_chromium ] -- Missing binary: /usr/bin/chromium`);
        }
    }
    
    async _afterChromiumStart() {
        func.fadeVolume(0, `${path.basename(__filename)} startChromium() service_chromium.on(ready)`);
        await func.raiseWindow_Chromium();
        await func.activateWindow_Chromium();

        if (String(this.targetSource).toLowerCase() !== 'none')
        {
            setTimeout(() => {
                this.startNdiReceiver(this.targetSource);
            }, 5000);
        }
    }

    async _closeChromium() {
        if (this.service_chromium)
        {
            await this.service_chromium.close();
            this.service_chromium = null;
        }
    }

    /**
     * OPEN CEC CONTROLER
     */
    openCecController() {
        this.controller_cec = new (require('./service/client_cec.js'))(this.settings);

        this.controller_cec.on('ready', () => {
            this.server_api.controller_cec = this.controller_cec;

            setTimeout(() => {
                this.controller_cec.send('as');
            }, 2000);
        });

        this.controller_cec.once('timeout', (data) => {
            console.info(`[ ${path.basename(__filename).split('.')[0]} ][ client_cec ]`, data);
        });

        this.controller_cec.on('event', (data) => {
            console.info(`[ ${path.basename(__filename).split('.')[0]} ][ client_cec ]`, data);
        });
        
        this.controller_cec.on('error_log', (data) => {
            console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ client_cec ][ ERROR ]`, data);
        });

        this.controller_cec.once('close', (data) => {
            console.info(`[ ${path.basename(__filename).split('.')[0]} ][ client_cec ] ${String(data || 'CEC Unavailable')}`);
            this.controller_cec = null;
        });
    }

    async _closeCecController() {
        if (this.controller_cec)
        {
            await this.controller_cec.close();
            console.log('*** SHUTDOWN ⎯ 5 (2 of 2) [ End   [_closeCecController] ]');
            this.controller_cec = null;
        }
    }

    /**
     * LAUNCH NDI RECEIVER
     */
    async startNdiReceiver(source = 'none') {
        if (source !== this.targetSource)
        { this.targetSource = source; }
        
        await this._closeNdiReceiver();
        
        if (source == 'none')
        { return; }

        this.ndiReceiver = new (require('./service/client_ndiReceiver.js'))(this.settings, this.server_api);

        this.ndiReceiver.on('close', () => {
            this.ndiReceiver = null;
        });
    }

    async _closeNdiReceiver() {
        if (this.ndiReceiver)
        { await this.ndiReceiver.close(); }
    }

    async _killNdiReceiver() {
        console.log('*** SHUTDOWN ⎯ 1 (1 of 2) [ Start [_killNdiReceiver] ]');
        return new Promise((resolve) => {
            if (this.ndiReceiver)
            {
                let autoResolve = setTimeout(() => {
                    resolve();
                }, 5000);

                if (this.ndiReceiver.receiver)
                {
                    this.ndiReceiver.once('killed', () => {
                        this.ndiReceiver = null;
                        console.log('*** SHUTDOWN ⎯ 1 (2 of 2) [ End   [_killNdiReceiver]: A ]');
                        clearTimeout(autoResolve);
                        resolve();
                    });
                    this.ndiReceiver.receiver.kill('SIGKILL');
                }
                else
                {
                    clearTimeout(autoResolve);
                    console.log('*** SHUTDOWN ⎯ 1 (2 of 2) [ End   [_killNdiReceiver]: B ]');
                    resolve();
                }
            }
            else
            {
                console.log('*** SHUTDOWN ⎯ 1 (2 of 2) [ End   [_killNdiReceiver]: C ]');
                resolve();
            }
        });
    }

    /** HELPER FUNCTIONS */
}

// ******************************************************
// *                                                    *
// *                START NDPi PROCESS                  *
// *                                                    *
// ******************************************************
let quitAttempts = 0;
const index = new NDPi();

async function shutdownDevice() {
    await quitNDPi('SIGTERM');
    // await new Promise((resolve) => { setTimeout(() => { resolve(); }, 1000); });
    exec('sudo shutdown now');
}

async function rebootDevice() {
    await quitNDPi('SIGTERM');
    // await new Promise((resolve) => { setTimeout(() => { resolve(); }, 1000); });
    exec('sudo reboot');
}

async function quitNDPi(signal) {
    const sig = signal ? `[ ${signal} ]` : '';
    console.info(`[ ${path.basename(__filename).split('.')[0]} ]${sig} Exiting NDPi`);
    
    index.shutdown = true;

    index.airPlay.once('close', () => {
        console.log('AIRPLAY CLOSED');
    });
    index.airPlay.kill('SIGINT');

    return new Promise(async (resolve) => {
        const timeout = setTimeout(() => {
            console.error('GRACEFUL SHUTDOWN TIMEOUT EXPIRED. FORCING EXIT');
            resolve();
        }, 10000);

        console.log('*** SHUTDOWN ⎯ 1');
        await index._killNdiReceiver();

        console.log('*** SHUTDOWN ⎯ 2');
        try {
            console.log('*** SHUTDOWN ⎯ 2 (1 of 2) [ Start [ndpiServerStatusUpdate]: clearInterval ]');
            clearInterval(index.ndpiServerStatusUpdate);
            console.log('*** SHUTDOWN ⎯ 2 (2 of 2) [ End   [ndpiServerStatusUpdate]: clearInterval ]');
        }
        catch {}
        finally { index.ndpiServerStatusUpdate = null; }

        console.log('*** SHUTDOWN ⎯ 3');
        try {
            console.log('*** SHUTDOWN ⎯ 3 (1 of 2) [ Start [lcdDisplayRestartTimer]: clearInterval ]');
            clearTimeout(index.lcdDisplayRestartTimer);
            console.log('*** SHUTDOWN ⎯ 3 (2 of 2) [ End   [lcdDisplayRestartTimer]: clearInterval ]');
        }
        catch {}
        finally { index.lcdDisplayRestartTimer = null; }

        // console.log('*** SHUTDOWN ⎯ 4');
        // await index._closeLcdDisplay().catch();

        console.log('*** SHUTDOWN ⎯ 5');
        await index._closeCecController().catch();

        console.log('*** SHUTDOWN ⎯ 6');
        await index._closeMdns().catch();

        console.log('*** SHUTDOWN ⎯ 7');
        try { index.wsConnection_ndpiServer.close(); }
        catch {}
        finally {}

        console.log('*** SHUTDOWN ⎯ 8');
        await index._closeApi().catch();

        console.log('*** SHUTDOWN ⎯ 9');
        index._closeFsData();

        clearTimeout(timeout);
        resolve();
    });
}

process.on('uncaughtException', (err) => {
    console.error(' ');
    console.error('🔴🔴🔴');
    console.error('Uncaught Exception');
    console.error('------------------');
    console.error(err);
    console.error('------------------');
    console.error('🔴🔴🔴');
    console.error(' ');
});

process.on('unhandledRejection', async (reason) => {
    console.error(' ');
    console.error('🔴');
    console.error('🔴🔴');
    console.error('🔴🔴🔴');
    console.error('Unhandled REJECTION');
    console.error('-------------------');
    console.error(reason);
    console.error('-------------------');
    console.error('  Restarting NDPi  ');
    console.error('🔴🔴🔴');
    console.error('🔴🔴');
    console.error('🔴');
    console.error(' ');
    exit(1);
    // if (quitAttempts < 10)
    // {
    //     quitAttempts++;
    //     await quitNDPi('unhandledRejection');
    //     exit(0);
    // }
    // else
    // { exit(1); }
});

process.on('SIGTERM', async () => {
    await quitNDPi('SIGTERM');
    exit(0);
});

process.on('SIGINT', async () => {
    await quitNDPi('SIGINT');
    exit(0);
});

process.on('exit', (code) => {
    console.info(`[ EXIT CODE: ${code} ]`);
    console.info('══════════════════════════════════════════  N D P i - M O N I T O R  ═══');
});