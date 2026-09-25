const { EventEmitter } = require('events');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { setInterval, clearInterval } = require('timers');
const func = require('./functions.js');
const { exec, spawn } = require('node:child_process');
const { setTimeout } = require('node:timers');

// EDID manufacturer (PNP ID -> readable company name) lookup table --
// edid-decode only ever reports the raw 3-letter PNP ID (e.g. 'SNY'), not
// a human-readable name. Loaded defensively (readFileSync + JSON.parse
// wrapped in try/catch, not require()) so a missing/malformed
// edid_mfr.json just falls back to showing the raw PNP ID everywhere
// instead of crashing the Client at boot.
const edidManufacturerMap = new Map();
try
{
    const edidMfrPath = path.join(__dirname, '..', 'edid_mfr.json');
    const edidMfrList = JSON.parse(fs.readFileSync(edidMfrPath, 'utf8'));
    for (const entry of edidMfrList)
    {
        const pnpId = String(entry?.PNP_ID || '').trim().toUpperCase();
        if (pnpId && entry?.Company)
        { edidManufacturerMap.set(pnpId, entry.Company); }
    }
}
catch (err)
{ console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ] Loading edid_mfr.json`, err); }

function lookupEdidManufacturer(pnpId) {
    const normalized = String(pnpId || '').trim().toUpperCase();
    return edidManufacturerMap.get(normalized) || pnpId;
}

class FileSystemMonitor extends EventEmitter {
    #pgmVersion;
    #pgmVersionDate;
    #ipPoll;
    #updatePoll;
    #updatePollInterval;
    constructor(version = '1.0.0', versionDate = '1970-01-01') {
        super();

        this.watcherEnable = true;
        this.watcher = null;
        this.setMaxListeners(100)

        this.defaultDeviceName = 'NDPi Client';

        this.#ipPoll = null;
        this.ipPollInterval = (5 * 60) * 1000;
        this.ipPollEnable = true;

        this.#updatePoll = null;
        this.#updatePollInterval = String(process.env.NODE_ENV || 'PRODUCTION') === 'PRODUCTION' ?
            (1440 * 60) * 1000 :
            (5 * 60) * 1000;
        this.updatePollEnable = true;

        this.dataDir = process.env.DATA_NDPI_PATH;
        this.fileMap = null;

        this.debounceMap = new Map();
        this.queue = [];

        this.#pgmVersion = version;
        this.#pgmVersionDate = new Date(versionDate).toISOString().split('T')[0];

        this.serverCommunicationWebSocket = null;

        this.drmMonitor = null;
        this.debounceTimerDrmEvents = null;

        this.lcdDisplayScriptPath = path.join(__dirname, '..', 'python', 'script');
        this.sendToLCD = [
            'device_name',
            'device_id',
            'device_ip',
            'ndpi_version',
            'ndpi_status_ndi_status',
            'ndpi_status_ndi_source_target',
        ];

        process.nextTick(() => { this.init(); });
    }

    async init() {
        console.info(`[ ${path.basename(__filename).split('.')[0]} ][ -INITIATE ] NDPi Data Management Module - v${this.#pgmVersion} - ${this.#pgmVersionDate}`);

        // Create directory if it doesn't exist.
        if (!fs.existsSync(this.dataDir))
        { fs.mkdirSync(this.dataDir, { recursive: true }) }

        // Set the deviceId from either serial-number or machine-id
        let deviceId = '';

        const deviceIdPaths = [
            path.join('/sys','firmware','devicetree','base','serial-number'),
            path.join('/etc','machine-id'),
        ];

        if (fs.existsSync(deviceIdPaths[0]) || fs.existsSync(deviceIdPaths[1]))
        {
            try
            {
                deviceId = fs.readFileSync(deviceIdPaths[0], 'utf8').replace(/\0/g, '').trim().toUpperCase();
                console.info(`[ ${path.basename(__filename).split('.')[0]} ][ DEVICE ID ] ${deviceId}`);
            }
            catch 
            {
                deviceId = fs.readFileSync(deviceIdPaths[1], 'utf8').replace(/\0/g, '').trim().toUpperCase();
                console.info(`[ ${path.basename(__filename).split('.')[0]} ][ FALLBACK DEVICE ID ] ${deviceId}`);
            }
        }
        else // MacOS Compatability
        {
            await new Promise((resolve) => {
                exec(`ioreg -l | grep IOPlatformSerialNumber | awk '{print $4}' | tr -d '"'`, (error, stdout) => {
                    if (!error)
                    { deviceId = stdout.trim().toUpperCase(); }
                    resolve();
                });
            })
        }

        // Map file names and values with to standard defaults.
        this.fileMap = new Map();
        const files = [
            { 
                key: "device_name",
                value: `${this.defaultDeviceName}`,
                group: `Device`,
                allowEditInternal: true,
                allowEditExternal: true,
            },
            {
                key: "device_type",
                value: `NDPi Monitor Client`,
                group: `Device`,
                allowEditInternal: false,
                allowEditExternal: false,
            },
            {
                key: "device_id",
                value: `${deviceId}`,
                group: `Device`,
                allowEditInternal: false,
                allowEditExternal: false,
            },
            {
                key: "device_ip",
                value: ``,
                group: `Device`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "device_volume",
                value: `255`,
                options: [
                    [ '0', '0.0' ],
                    [ '1', '0.1204' ],
                    [ '2', '0.2466' ],
                    [ '3', '0.3787' ],
                    [ '4', '0.517' ],
                    [ '5', '0.6619' ],
                    [ '6', '0.8136' ],
                    [ '7', '0.9724' ],
                    [ '8', '1.1388' ],
                    [ '9', '1.313' ],
                    [ '10', '1.4955' ],
                    [ '11', '1.6866' ],
                    [ '12', '1.8867' ],
                    [ '13', '2.0962' ],
                    [ '14', '2.3157' ],
                    [ '15', '2.5455' ],
                    [ '16', '2.7862' ],
                    [ '17', '3.0382' ],
                    [ '18', '3.3022' ],
                    [ '19', '3.5786' ],
                    [ '20', '3.8681' ],
                    [ '21', '4.1712' ],
                    [ '22', '4.4887' ],
                    [ '23', '4.8211' ],
                    [ '24', '5.1693' ],
                    [ '25', '5.5339' ],
                    [ '26', '5.9157' ],
                    [ '27', '6.3156' ],
                    [ '28', '6.7343' ],
                    [ '29', '7.1728' ],
                    [ '30', '7.6321' ],
                    [ '31', '8.113' ],
                    [ '32', '8.6167' ],
                    [ '33', '9.1441' ],
                    [ '34', '9.6964' ],
                    [ '35', '10.2749' ],
                    [ '36', '10.8806' ],
                    [ '37', '11.515' ],
                    [ '38', '12.1793' ],
                    [ '39', '12.875' ],
                    [ '40', '13.6036' ],
                    [ '41', '14.3666' ],
                    [ '42', '15.1656' ],
                    [ '43', '16.0023' ],
                    [ '44', '16.8786' ],
                    [ '45', '17.7963' ],
                    [ '46', '18.7573' ],
                    [ '47', '19.7637' ],
                    [ '48', '20.8176' ],
                    [ '49', '21.9213' ],
                    [ '50', '23.0772' ],
                    [ '51', '24.2876' ],
                    [ '52', '25.5552' ],
                    [ '53', '26.8827' ],
                    [ '54', '28.2729' ],
                    [ '55', '29.7288' ],
                    [ '56', '31.2534' ],
                    [ '57', '32.85' ],
                    [ '58', '34.522' ],
                    [ '59', '36.2731' ],
                    [ '60', '38.1068' ],
                    [ '61', '40.0271' ],
                    [ '62', '42.0381' ],
                    [ '63', '44.1442' ],
                    [ '64', '46.3497' ],
                    [ '65', '48.6593' ],
                    [ '66', '51.0781' ],
                    [ '67', '53.6111' ],
                    [ '68', '56.2637' ],
                    [ '69', '59.0417' ],
                    [ '70', '61.9508' ],
                    [ '71', '64.9974' ],
                    [ '72', '68.1878' ],
                    [ '73', '71.5289' ],
                    [ '74', '75.0279' ],
                    [ '75', '78.6921' ],
                    [ '76', '82.5294' ],
                    [ '77', '86.5479' ],
                    [ '78', '90.7563' ],
                    [ '79', '95.1634' ],
                    [ '80', '99.7787' ],
                    [ '81', '104.6119' ],
                    [ '82', '109.6735' ],
                    [ '83', '114.9741' ],
                    [ '84', '120.5251' ],
                    [ '85', '126.3383' ],
                    [ '86', '132.426' ],
                    [ '87', '138.8013' ],
                    [ '88', '145.4777' ],
                    [ '89', '152.4695' ],
                    [ '90', '159.7914' ],
                    [ '91', '167.4593' ],
                    [ '92', '175.4893' ],
                    [ '93', '183.8986' ],
                    [ '94', '192.705' ],
                    [ '95', '201.9275' ],
                    [ '96', '211.5855' ],
                    [ '97', '221.6997' ],
                    [ '98', '232.2917' ],
                    [ '99', '243.3839' ],
                    [ '100', '255.0' ]
                ],
                group: `Device`,
                allowEditInternal: true,
                allowEditExternal: true,
            },
            {
                key: "local_port_number_api",
                value: `${process.env.PORT_API || 3080}`,
                group: `Backend`,
                allowEditInternal: true,
                allowEditExternal: true,
            },
            {
                key: "local_port_number_bonjour",
                value: `${process.env.PORT_MDNS || 3053}`,
                group: `Backend`,
                allowEditInternal: true,
                allowEditExternal: true,
            },
            {
                key: "ndpi_version_update_available",
                value: `false`,
                group: `Backend`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "ndpi_version_update_version",
                value: ``,
                group: `Backend`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "ndpi_version_update_version_date",
                value: ``,
                group: `Backend`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "ndpi_version",
                value: this.#pgmVersion,
                group: `Backend`,
                allowEditInternal: false,
                allowEditExternal: false,
            },
            {
                key: "ndpi_version_date",
                value: this.#pgmVersionDate,
                group: `Backend`,
                allowEditInternal: false,
                allowEditExternal: false,
            },
            {
                key: "ndpi_hub_hostname",
                value: ``,
                group: `Backend`,
                allowEditInternal: true,
                allowEditExternal: true,
            },
            {
                key: "ndpi_hub_port",
                value: ``,
                group: `Backend`,
                allowEditInternal: true,
                allowEditExternal: true,
            },
            {
                key: "ndpi_airplay_server_pin",
                value: ``,
                group: `Backend`,
                allowEditInternal: true,
                allowEditExternal: true,
            },
            {
                key: "ndpi_command_log",
                value: `System Initial Run: v${this.#pgmVersion} ${this.#pgmVersionDate}`,
                group: ``,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "ndpi_status_ndi_status", 
                value: `idle`,
                group: `Source`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "ndpi_status_ndi_source_target",
                value: ``,
                group: `Source`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "ndpi_status_ndi_source_active",
                value: ``,
                group: `Source`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "ndpi_status_ndi_source_resolution",
                value: ``,
                group: `Source`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "ndpi_status_ndi_source_framerate",
                value: ``,
                group: `Source`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "ndpi_status_ndi_source_connected_time", 
                value: ``,
                group: `Source`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "ndpi_status_no_source_display_mode",
                value: `overlay`,
                options: [
                    [ 'Overlay', 'overlay' ],
                    [ 'Blank',   'blank'   ],
                ],
                group: `Source`,
                allowEditInternal: true,
                allowEditExternal: true,
            },
            {
                key: "ndpi_status_mdns_service",
                value: `down`,
                group: ``,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "ndi_receiver_bandwidth",
                value: `0`,
                options: [
                    [ 'Metadata Only', '-10'        ],
                    [ 'Audio Only',    '10'         ],
                    [ 'Lowest',        '0'          ],
                    [ 'Highest',       '100'        ],
                    [ 'Max',           '0x7fffffff' ],
                ],
                group: `Receiver`,
                allowEditInternal: true,
                allowEditExternal: true,
            },
            {
                key: "ndi_receiver_color_format",
                value: `100`,
                options: [
                    [ 'BGRx_BGRa', '0'   ],
                    [ 'UYVY_BGRa', '1'   ],
                    [ 'RGBx_RGBa', '2'   ],
                    [ 'UYVY_RGBa', '3'   ],
                    [ 'Fastest',   '100' ],
                    [ 'Best',      '101' ],
                ],
                group: `Receiver`,
                allowEditInternal: true,
                allowEditExternal: true,
            },
            {
                key: "ndi_receiver_scale_method",
                value: `bilinear`,
                options: [
                    // [ 'Nearest',  'nearest'  ],
                    // [ 'Linear',   'linear'   ],
                    // [ 'Cubic',    'cubic'    ],
                    [ 'Lanczos',  'lanczos'  ],
                    [ 'Bilinear', 'bilinear' ],
                ],
                group: `Receiver`,
                allowEditInternal: true,
                allowEditExternal: true,
            },
            {
                key: "ndi_source_discovery_exec",
                value: `ndi_discover_v2`,
                group: `Receiver`,
                allowEditInternal: false,
                allowEditExternal: false,
            },
            {
                key: "ndi_receiver_exec",
                value: `ndi_receiver_v4`,
                group: `Receiver`,
                allowEditInternal: false,
                allowEditExternal: false,
            },
            {
                key: "output_display_resolution_preference",
                value: ``,
                group: `Display_Resolution`,
                options: [],
                allowEditInternal: true,
                allowEditExternal: true,
            },
            {
                key: "output_display_framerate_preference",
                value: ``,
                group: `Display_Resolution`,
                options: [],
                allowEditInternal: true,
                allowEditExternal: true,
            },
            {
                key: "output_display_resolution_current",
                value: ``,
                group: `Display_Resolution`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "output_display_framerate_current",
                value: ``,
                group: `Display_Resolution`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "output_display_resolution_preferred",
                value: ``,
                group: `Display_Resolution`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "output_display_framerate_preferred",
                value: ``,
                group: `Display_Resolution`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "output_display_port",
                value: ``,
                group: `Display_Resolution`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "output_display_manufacturer",
                value: ``,
                group: `Display_Resolution`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "output_display_model",
                value: ``,
                group: `Display_Resolution`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "output_display_model_number",
                value: ``,
                group: `Display_Resolution`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "output_display_serial_number",
                value: ``,
                group: `Display_Resolution`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "output_display_cec_enabled",
                value: `false`,
                group: `CEC`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "output_display_cec_status_power",
                value: `unknown`,
                group: `CEC`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "output_display_cec_this_source_active",
                value: ``,
                group: `CEC`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "output_display_cec_version",
                value: ``,
                group: `CEC`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "output_display_cec_address",
                value: ``,
                group: `CEC`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "media_overlay_image",
                value: ``,
                group: ``,
                allowEditInternal: true,
                allowEditExternal: true,
            },
            {
                key: "pid_chromium",
                value: ``,
                group: `PROCESSES`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "pid_ndi_player",
                value: ``,
                group: `PROCESSES`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            {
                key: "pid_air_play_player",
                value: ``,
                group: `PROCESSES`,
                allowEditInternal: true,
                allowEditExternal: false,
            },
            { 
                key: "local_api_allowed_origins",
                value: JSON.stringify([
                    'http://ndpi-server.local:3080',
                    'http://ndpi-hub.local:3080',
                ], null, 2),
                group: `Backend`,
                allowEditInternal: true,
                allowEditExternal: true,
            },
        ];
        // Files that will NOT initialize with the previously stored value.
        const retainDefaultValue = [
            'ndpi_version',
            'ndpi_version_date',
            'ndpi_version_update_available',
            'ndpi_version_update_version',
            'device_id',
            'device_type',
            'device_ip',
            'exec_ndi_source_discovery',
            'ndi_receiver_exec',
            'local_port_number_bonjour',
            'local_port_number_api',
            'ndpi_status_ndi_status',
            'ndpi_status_ndi_source_active',
            'ndpi_status_ndi_source_connected_time',
            'ndpi_status_ndi_source_resolution',
            'ndpi_status_ndi_source_framerate',
            'output_display_cec_enabled',
            'output_display_cec_status_power',
            'output_display_cec_this_source_active',
            'output_display_cec_version',
            'output_display_cec_address',
            'pid_chromium',
            'pid_ndi_player',
            'pid_air_play_player',
        ];

        for (const file of files)
        {
            let setting = file;
            let getValueFromFile = true;

            const filePath = path.join(this.dataDir, setting.key);

            if (retainDefaultValue.includes(setting.key))
            { getValueFromFile = false }

            try
            {
                if (fs.existsSync(filePath) && getValueFromFile)
                {
                    const currentValue = fs.readFileSync(filePath, 'utf8').replace(/\0/g, '').trim();
                    setting.value = currentValue;
                    this.fileMap.set(setting.key, setting);
                }
                else
                {
                    fs.writeFileSync(filePath, setting.value, 'utf8');
                    this.fileMap.set(setting.key, setting);
                }
            }
            catch (err)
            { console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ] Saving File: Name:${setting.key}, Value: ${setting.value}`, err) }
            
            if (this.sendToLCD.includes(setting.key))
            { fs.writeFileSync(path.join(__dirname, '..', 'python', 'script', setting.key), setting.value, 'utf8'); }
        };

        this.start();
    }

    async start() {
        this.startWatcher();
        this.startDrmMonitor();
        this.updateOutputDisplayFiles();
        this.pollUpdate();
        this.emit('ready');
        await func.waitForNetwork();
        this.pollIp();
    }

    startWatcher() {
        this.watcher = fs.watch(this.dataDir);
        this.watcher.on('change', (eventType, filename) => {
            if (this.fileMap.has(filename))
            { this._fsEvent(filename); }
        });
    }
    
    _fsEvent(name, debounceMs = 500) {
        const last = this.debounceMap.get(name) || 0;
        const now = Date.now();

        if (now - last < debounceMs)
        { return; }

        this.debounceMap.set(name, now);
        this.queue.push({ name });

        setTimeout(() => { this.__flushQueue(); }, debounceMs);
    }

    async __flushQueue() {
        let updated = false;

        while (this.queue.length > 0)
        {
            const { name } = this.queue.shift();

            let currentValue = this.fileMap.get(name);
            const fsValue = fs.readFileSync(path.join(this.dataDir, name), 'utf8').replace(/\0/g, '').trim();
            
            if (currentValue.value !== fsValue)
            {
                currentValue.value = fsValue;
                this.fileMap.set(name, currentValue);

                if (name === 'media_overlay_image')
                { console.info(`[ ${path.basename(__filename).split('.')[0]} ][ UPDATE ] '${name}'`); }
                else
                { console.info(`[ ${path.basename(__filename).split('.')[0]} ][ UPDATE ] '${name}' ==> '${fsValue}'`); }

                if (name === 'output_display_resolution_preference' || name === 'output_display_framerate_preference')
                { this.updateOutputDisplayFiles(); }

                if (this.sendToLCD.includes(name))
                { fs.writeFileSync(path.join(this.lcdDisplayScriptPath, name), fsValue, 'utf8'); }

                this.emit(name, fsValue);
                updated = true;
            }
        }

        if (updated)
        { this.emit('update', JSON.stringify(Array.from(this.fileMap))); }

        return;
    }

    /**
     * 
     * @param {boolean} stringify - Return the Array as a string.
     * @returns {String|Array}
     */
    getAll(stringify = true) {
        if (stringify)
        { return JSON.stringify(Array.from(this.fileMap)); }
        else
        { return Array.from(this.fileMap); }
    }

    get(fileName) {
        if (!fileName || !this.fileMap.has(fileName))
        { return null; }
        return this.fileMap.get(fileName).value;
    }

    put(fileName, data = '') {
        if (!fileName || !this.fileMap.has(fileName))
        { return; }
        
        try
        { fs.writeFileSync(path.join(this.dataDir, fileName), data.trim(), 'utf8'); }
        catch (error)
        { console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ] Saving to FileSystem`); }
    }

    startDrmMonitor() {
        try
        { exec('killall -s SIGKILL udevadm'); }
        catch {}
        finally
        { this.drmMonitor = null;}

        console.info(`[ ${path.basename(__filename).split('.')[0]} ] Starting DRM Event Monitor`);

        this.drmMonitor = spawn('udevadm', ['monitor', '--subsystem-match=drm', '--kernel']);

        this.drmMonitor.stdout.on('data', (data) => {
            this.drmEvent();
        });

        this.drmMonitor.stderr.on('data', (data) => {

        });
        this.drmMonitor.on('error', (error) => {
            console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ] 'udevadm' DRM monitor disabled`, error.toString());
        });

        this.drmMonitor.once('close', () => {
            try
            {
                clearTimeout(this.debounceTimerDrmEvents);
                this.debounceTimerDrmEvents = null;
            }
            catch {}
            // finally { this.updateOutputDisplayFiles(); }
        });
    }

    drmEvent(debounceMs = 800) {
        if (this.debounceTimerDrmEvents)
        {
            clearTimeout(this.debounceTimerDrmEvents);
            this.debounceTimerDrmEvents = null;
        }
        this.debounceTimerDrmEvents = setTimeout(() => {
            this.updateOutputDisplayFiles();
            this.debounceTimerDrmEvents = null;
        }, debounceMs);
    }

    async close() {
        this.watcherEnable = false;
        this.ipPollEnable = false;
        this.updatePollEnable = false;

        console.info( `[ CLOSING ][ ${path.basename(__filename).split('.')[0]} ]`);

        try { clearTimeout(this.#ipPoll); } catch {}
        finally { this.#ipPoll = null; }

        try { clearTimeout(this.#updatePoll); } catch {}
        finally { this.#updatePoll = null; }

        if (this.watcher)
        {  this.watcher.close(); }

        if (this.debounceTimerDrmEvents)
        {
            clearTimeout(this.debounceTimerDrmEvents);
            this.debounceTimerDrmEvents = null;
        }

        return new Promise((resolve) => {
            exec('killall -s SIGKILL udevadm', async () => {
                console.info( `[ -CLOSED ][ ${path.basename(__filename).split('.')[0]} ]`);
                resolve();
            });
        })
    }



    /**
     *  Helper Functions
     */

    async pollIp() {
        try { await this.updateLocalIp(); }
        catch {}
        finally
        {
            if (this.ipPollEnable)
            {
                this.#ipPoll = null;
                this.#ipPoll = setTimeout(() => {
                    this.pollIp();
                }, this.ipPollInterval);
            }
        }
    }

    async pollUpdate() {
        try { await func.checkForUpdate(); } catch {}
        try { await this.updateOutputDisplayFiles(); } catch {}
        finally
        {
            if (this.updatePollEnable)
            {
                this.#updatePoll = null;
                this.#updatePoll = setTimeout(() => {
                    this.pollUpdate();
                }, this.#updatePollInterval);
            }
        }
    }

    async updateLocalIp() {
        let fileName = 'device_ip';
        let valueUpdate = null;

        await new Promise((resolve) => {
            exec('ip -j address', (error, stdout, stderr) => {
                if (error)
                {
                    console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ] Error Reading IP Address.`, stderr.toString());
                    resolve();
                }
                else
                {
                    try
                    {
                        let output = JSON.parse(String(stdout));
                        if (Array.isArray(output))
                        {
                            output = output
                                .filter(link => link.link_type == 'ether')
                                .filter(link => link.operstate == 'UP');

                            if (output.length >= 1)
                            {
                                const output_obj = output[0];
                                if (Array.isArray(output_obj.addr_info))
                                {
                                    let output_addr_info = output_obj.addr_info.filter(addr => addr.family == 'inet');
                                    if (output_addr_info.length === 1)
                                    { valueUpdate = output_addr_info[0].local; }
                                }
                            }
                        }
                    }
                    catch (error)
                    { console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ] Error Reading IP Address.`, error); }
                    finally
                    { resolve(); }
                }
            });
        });

        if (valueUpdate)
        {
            const storedValue = this.fileMap.get(fileName).value;
            if (valueUpdate !== storedValue)
            {
                this.put(fileName, valueUpdate);
                this.ipPollInterval = 10000;
            }
        }
        else
        {
            this.put(fileName, '');
            this.ipPollInterval = 1000;
        }
        return;
    }

    async updateOutputDisplayFiles() {
        let HDMI_1;
        let HDMI_2;

        // console.info(`[ ${path.basename(__filename).split('.')[0]} ][ DRM ] Retrieving Display Data`);

        await new Promise((resolve) => {
            exec('cat /sys/class/drm/card*HDMI*/status', (error, stdout, stderr) => {
                if (error)
                { console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ updateOutputDisplayFiles() ][ ERROR ]`, stderr.toString().trim()); }
                else
                {
                    const output = func.stdoutToArray(stdout);
                    HDMI_1 = output[0] || 'disconnected';
                    HDMI_2 = output[1] || 'disconnected';
                    resolve();
                }
            });
        });

        if (HDMI_1 === 'disconnected' && HDMI_2 === 'disconnected')
        {
            this.put('output_display_port', '');
            this.put('output_display_resolution_preferred', '');
            this.put('output_display_framerate_preferred', '');
            this.put('output_display_manufacturer', '');
            this.put('output_display_model', '');
            this.put('output_display_model_number', '');
            this.put('output_display_serial_number', '');
            this.put('output_display_cec_enabled', 'false');
            this.put('output_display_cec_status_power', 'unknown');
            this.put('output_display_cec_this_source_active', 'false');
            this.put('output_display_cec_version', '');
            this.put('output_display_cec_address', '');
            this.put('output_display_framerate_preference', '');
            this.emit('drm');
        }
        else
        {
            const commandPath = path.join(__dirname, '..', 'sh', 'current-resolution');
            exec(commandPath, (error, stdout, stderr) => {
                if (error)
                { console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ updateOutputDisplayFiles() ][ ERROR ] ${stderr.toString().trim()}`); }
                else
                {
                    let resolutionOptions = [];
                    let framerateOptions = [];
                    func.stdoutToArray(stdout).forEach((line) => {
                        const output        = line.toString().trim();
                        const lineSplit_1   = output.split(' : ');
                        const splitKey      = String(lineSplit_1[0] || '').trim();
                        const splitValue    = String(lineSplit_1[1] || '').trim();
                        
                        let lineSplit_2 = null;
                        let splitOptKey = null;
                        let splitOptValue = null;

                        if (splitValue.includes(' :: '))
                        {
                            lineSplit_2   = splitValue.split(' :: ');
                            splitOptKey   = String(lineSplit_2[0] || '').trim();
                            splitOptValue = String(lineSplit_2[1] || '').trim();
                        }

                        switch(splitKey)
                        {
                            case 'current_output':
                                this.put('output_display_port', splitValue);
                                return;
                                break;
                            case 'current_resolution':
                                this.put('output_display_resolution_current', splitValue);
                                return;
                                break;
                            case 'current_framerate':
                                this.put('output_display_framerate_current', splitValue);
                                return;
                                break;
                            case 'preferred_resolution':
                                this.put('output_display_resolution_preferred', splitValue);
                                return;
                                break;
                            case 'preferred_framerate':
                                this.put('output_display_framerate_preferred', splitValue);
                                return;
                                break;
                            case 'manufacturer_hdmi0':
                            case 'manufacturer_hdmi1':
                                this.put('output_display_manufacturer', lookupEdidManufacturer(splitValue));
                                return;
                                break;
                            case 'model_name_hdmi0':
                            case 'model_name_hdmi1':
                                this.put('output_display_model', splitValue);
                                return;
                                break;
                            case 'model_number_hdmi0':
                            case 'model_number_hdmi1':
                                this.put('output_display_model_number', splitValue);
                                return;
                                break;
                            case 'sn_hdmi0':
                            case 'sn_hdmi1':
                                this.put('output_display_serial_number', splitValue);
                                return;
                                break;
                            case 'list_resolutions':
                                if (splitOptKey && splitOptValue)
                                { resolutionOptions.push([splitOptValue, splitOptValue]); }
                                // { resolutionOptions.push([splitOptKey, splitOptValue]); }
                                return;
                                break;
                            case 'allowed_framerates':
                                const fileMapCurrFR = this.fileMap.get('output_display_framerate_preference');
                                const FRoptions = splitValue.split(' ');
                                for (const value of FRoptions) {
                                    framerateOptions.push([value, value]);
                                }
                                fileMapCurrFR.options = framerateOptions;
                                this.fileMap.set('output_display_framerate_preference', fileMapCurrFR);
                            default:
                                break;
                        }
                    });
                    const fileMapCurrRes = this.fileMap.get('output_display_resolution_preference');
                    fileMapCurrRes.options = resolutionOptions;
                    this.fileMap.set('output_display_resolution_preference', fileMapCurrRes);
                    this.emit('drm');
                    // Both the resolution and framerate options above mutate the
                    // fileMap in memory only -- __flushQueue() (the only other
                    // place that emits 'update') never runs for them, since no
                    // file on disk changed. Without this, /ws/system + /ws/display
                    // (and therefore the resolution/framerate dropdowns) would
                    // never learn the options changed until some unrelated
                    // setting happened to change and trigger its own broadcast.
                    this.emit('update', JSON.stringify(Array.from(this.fileMap)));
                }
            });
        }
    }
}

module.exports = FileSystemMonitor;