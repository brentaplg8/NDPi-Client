const { EventEmitter } = require('events');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('node:crypto');
const func = require('./functions');
const { randomUUID } = require('crypto');
const { spawn } = require('node:child_process');
const os = require('node:os');
const fs = require('node:fs');
const cors = require('cors');


class NDPiCommandServer_Client extends EventEmitter {
    constructor(fsData) {
        super();
        this.controller_cec = null;
        this.settings = fsData;
        this.isDev = String(process.env.NODE_ENV || 'PRODUCTION') === 'DEVELOPMENT';
        // 'development'
        this.cacheControl = this.isDev ?
            'no-store, no-cache, must-revalidate, private' :
            // 'public, max-age=86400, immutable';
            'no-store, no-cache, must-revalidate, private';
        
        try
        { this.allowedOrigins = JSON.parse(fsData.get('local_api_allowed_origins') || '[]'); }
        catch
        { this.allowedOrigins = []; }

        this.port = fsData.get('local_port_number_api') || process.env.PORT_API || 3080;

        fsData.on('update', (data) => {
            this.ws_conn_system.forEach(client => {
                try { client.send(data); }
                catch {}
            });
            this.ws_conn_display.forEach(client => {
                try { client.send(data); }
                catch {}
            });
        });

        this.closing = false;

        this.discoveryExec = null;
        this.availableSources = null;
        
        this.ws_serv_display = null;
        this.ws_conn_display = null;

        this.ws_serv_system = null;
        this.ws_conn_system = null;

        this.ws_serv_stats = null;
        this.ws_conn_stats = null;
        this.statsSendInterval = null;

        this.ws_serv_sources = null;
        this.ws_conn_sources = null;

        this.App = null;    // express()
        this.Server = null; // http.createServer()
        this.Routes = null; // express.Router()

        this.start();
    }

    start() {
        this.App = express();
        this.App.use(express.json());

        this.App.options('*', cors());
        this.App.use(cors({ origin: this.allowedOrigins }));

        this.App.use(
            '/script',
            express.static(path.join(__dirname, '..', 'public'), {
                setHeaders: (res, path) => { res.set('Cache-Control', this.cacheControl); }
            })
        );

        this.App.use(
            '/assets',
            express.static(path.join(__dirname, '..', 'assets'), {
                setHeaders: (res, path) => { res.set('Cache-Control', this.cacheControl) }
            })
        );

        this.__ws_Display();
        this.__ws_System();
        this.__ws_Stats();
        this.__ws_Sources();
        this.__Routers();
    }

    /**
     *      Overlay Display - WebSocket Connection Handler
     */
    __ws_Display() {
        this.ws_conn_display = new Set();
        this.ws_serv_display = new WebSocket.Server({ noServer: true });
        this.ws_serv_display.on('connection', (ws) =>{
            this.ws_conn_display.add(ws);
            ws.send(JSON.stringify(Array.from(this.settings.fileMap)));
            ws.onerror = (error) => {
                console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ]`, `Overlay Display WebSocket Server`, error);
            };
            ws.onclose = () => {
                this.ws_conn_display.delete(ws);
            };
        });
    }

    /**
     *      System GUI - WebSocket Connection Handler
     */
    __ws_System() {
        this.ws_conn_system = new Set();
        this.ws_serv_system = new WebSocket.Server({ noServer: true });
        this.ws_serv_system.on('connection', (ws) =>{
            this.ws_conn_system.add(ws);
            ws.send(JSON.stringify(Array.from(this.settings.fileMap)));
            ws.onmessage = (event) => {
                try
                { func.processCommand(JSON.parse(event.data)); }
                catch (error)
                { console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ]`, error); }
            };
            ws.onerror = (error) => {
                console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ]`, `System GUI WebSocket Server`, error);
            };
            ws.onclose = () => {
                this.ws_conn_system.delete(ws);
            };
        });
    }

    /**
     *      System Stats - WebSocket Connection Handler
     */
    __ws_Stats() {
        this.ws_conn_stats = new Set();
        this.ws_serv_stats = new WebSocket.Server({ noServer: true });
        this.ws_serv_stats.on('connection', (ws) =>{
            this.ws_conn_stats.add(ws);
            ws.send(JSON.stringify(this.getSystemStats()));
            this.startStats();
            ws.onerror = (error) => {
                console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ]`, `System Stats WebSocket Server`, error);
            };
            ws.onclose = () => {
                this.ws_conn_stats.delete(ws);
            };
        });
    }

    /**
     *      NDI Source - WebSocket Connection Handler
     */
    __ws_Sources() {
        this.ws_conn_sources = new Set();
        this.ws_serv_sources = new WebSocket.Server({ noServer: true });
        this.ws_serv_sources.on('connection', (ws) =>{
            this.ws_conn_sources.add(ws);
            if (this.availableSources)
            { ws.send(JSON.stringify(this.availableSources)); }
            if (!this.discoveryExec)
            { this.startDiscovery(); }
            ws.onerror = (error) => {
                console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ]`, `NDI Source WebSocket Server`, error);
            };
            ws.onclose = async () => {
                this.ws_conn_sources.delete(ws);
            };
        });
    }

    /**
     *      API Endpoint Routers
     */
    __Routers() {
        this.Routes = express.Router();
        this.App.use(this.Routes);
        this.startServer();

        this.Routes
        .route('/')
        .get((req, res) => {
            res.sendFile(path.join(__dirname, '..', 'public', 'system.html'));
        });

        this.Routes
        .route('/display/idle')
        .get((req, res) => {
            res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
        });

        /**
         *  Public API (v1)
         *      Required Input
         *      {
         *          type: <Command Type>,
         *          data: <Relevant Data [any]>
         *      }
         */
        this.Routes
        .route('/api/v1/rpc')
        .get(async (req, res) => {
            const commandRes = await func.processCommand({
                ...req.query,
                id: crypto.randomUUID(),
            });

            if (commandRes && commandRes.success)
            { res.status(200).json(commandRes); }
            else
            { res.status(400).json(commandRes); }
        })
        .post(async (req, res) => {
            if (this.isDev) { console.info(`[ ${path.basename(__filename).split('.')[0]} ]`, 'POST:', req.url); }

            const commandRes = await func.processCommand({
                ...req.body,
                id: crypto.randomUUID(),
            });

            if (commandRes && commandRes.success)
            { res.status(200).json(commandRes); }
            else
            { res.status(400).json(commandRes); }
        });

        /**
         *  Adopt (v1)
         *      Required Input
         *      {
         *          hubHostname: <Hub's reachable hostname/IP>,
         *          hubPort: <Hub's API port>
         *      }
         */
        this.Routes
        .route('/api/v1/adopt')
        .post((req, res) => {
            const { hubHostname, hubPort } = req.body || {};

            if (!hubHostname || !hubPort)
            {
                res.status(400).json({ success: false, message: `Missing 'hubHostname' and/or 'hubPort'.` });
                return;
            }

            this.settings.put('ndpi_hub_hostname', String(hubHostname));
            this.settings.put('ndpi_hub_port', String(hubPort));

            console.info(`[ ${path.basename(__filename).split('.')[0]} ]`, `Adopted by Hub at ${hubHostname}:${hubPort}`);
            res.status(200).json({ success: true, message: `Hub connection configured: ${hubHostname}:${hubPort}` });
        });

        /**
         *  Internal API (v1)
         *      Required Inputs
         *          PATH '/internal/api/v1/{PATH}'
         *          BODY {data} of any type
         */
        this.Routes
        .route('/api/v1/__internal/:path')
        .get((req, res) => {
            res.sendStatus(403)
        })
        .post((req, res) => {
            const { id, data } = req.body;
            const switch_path  = req.params.path;

            if (req.hostname !== 'localhost')
            {
                res.status(403);
                res.json({ success: false, message: 'forbidden' });
                return;
            }

            let reqValid = false;
            switch (switch_path) {

                case 'cec':
                    reqValid = (typeof data === 'string' && this.controller_cec.isReady);
                    if (reqValid && this.controller_cec)
                    {
                        this.controller_cec.send(decodeURI(data));
                        res.status(200).json({ success: true });
                    }
                    else
                    { res.status(400).json({ success: false }); }
                    break;

                case 'ndi':
                    let source = String(data || 'none');
                    this.settings.put('ndpi_status_ndi_source_target', source);

                    res.status(200).json({ success: true, message: `NDI Source Set: ${source}` });
                    break;

                case 'shutdown':
                    res.status(200).json({ success: true });
                    this.emit('shutdown-command');
                    break;

                case 'reboot':
                    res.status(200).json({ success: true });
                    this.emit('reboot-command');
                    break;

                case 'get-settings':
                    res.status(200).json(this.settings.fsData.getAll() ?? []);

                default:
                    res.status(400).json({ success: false, message: `Path Does Not Exist` });
                    break;
            }
        });
    }

    startServer() {
        this.Server = http.createServer(this.App);

        this.Server.listen(this.port, '0.0.0.0', () => {
            console.info(`[ ${path.basename(__filename).split('.')[0]} ]`, `API Server Online`);
            console.info(`[ ${path.basename(__filename).split('.')[0]} ]`, `PORT: ${this.port}`);
            process.nextTick(() => { this.emit('online'); });
        });

        this.Server.on('request', (request) => {
            console.info(`[ ${path.basename(__filename).split('.')[0]} ]`, `Request:`, request.url);
        })

        this.Server.on('upgrade', (request, socket, head) => {
            const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
            
            if (pathname === '/ws/display') {
                this.ws_serv_display.handleUpgrade(request, socket, head, (ws) => {
                    this.ws_serv_display.emit('connection', ws, request);
                });
            } else if (pathname === '/ws/system') {
                this.ws_serv_system.handleUpgrade(request, socket, head, (ws) => {
                    this.ws_serv_system.emit('connection', ws, request);
                });
            } else if (pathname === '/ws/stats') {
                this.ws_serv_stats.handleUpgrade(request, socket, head, (ws) => {
                    this.ws_serv_stats.emit('connection', ws, request);
                });
            } else if (pathname === '/ws/sources') {
                this.ws_serv_sources.handleUpgrade(request, socket, head, (ws) => {
                    this.ws_serv_sources.emit('connection', ws, request);
                });
            } else {
                socket.destroy();
            }
        });
    }

    startDiscovery() {
        const discoveryPath = path.join(__dirname, '..', 'ndi_receiver_v3__NDI6');
        const programName = './ndpi_discover';
        
        console.info(`[ ${path.basename(__filename).split('.')[0]} ] Starting NDPi NDI® Discovery.`);

        this.discoveryExec = null;
        
        this.discoveryExec = spawn(programName, {
            cwd: discoveryPath
        });

        this.discoveryExec.stdout.on('data', (data) => {
            const output = data.toString() || '[]';
            try
            {
                this.availableSources = JSON.parse(output);
                if (Array.isArray(this.availableSources))
                {
                    this.ws_conn_sources.forEach((ws) => {
                        ws.send(JSON.stringify(this.availableSources));
                    });
                }
            }
            catch {}
        });
    }

    async _tryCloseDiscovery() {
        return new Promise((resolve) => {
            if (!this.discoveryExec.killed)
            {
                this.discoveryExec.once('exit', () => {
                    console.info(`[ -CLOSED ][ ${path.basename(__filename).split('.')[0]} ] NDPi NDI® Discovery`);
                    resolve();
                });

                console.info(`[ CLOSING ][ ${path.basename(__filename).split('.')[0]} ] NDPi NDI® Discovery`);
                this.discoveryExec.kill('SIGTERM');

                setTimeout(() => {
                    if (!this.discoveryExec.killed)
                    {
                        console.info(`[ -CLOSED ][ ${path.basename(__filename).split('.')[0]} ] NDPi NDI® Discovery`);
                        resolve();
                    }
                }, 2000);
            }
            else
            {
                console.info(`[ -CLOSED ][ ${path.basename(__filename).split('.')[0]} ] NDPi NDI® Discovery`);
                resolve();
            }
        });
    }

    startStats() {
        if (this.statsSendInterval) return;
        this.statsSendInterval = setInterval(() => {
            this.sendStats();
        }, 1000);
    }

    getSystemStats() {
        let pth_thermal_zone0 = path.join('/sys', 'class', 'thermal', 'thermal_zone0', 'temp');
        let thermal_zone0 = fs.readFileSync(pth_thermal_zone0, 'utf8').trim() || '0';
            thermal_zone0 = Number(thermal_zone0) / 1000;

        let fan1_input = null;
        let pth_fan1_input = path.join('/sys', 'class', 'hwmon', 'hwmon0', 'fan1_input');

        if (!fan1_input)
        {
            if (fs.existsSync(pth_fan1_input))
            { fan1_input = fs.readFileSync(pth_fan1_input, 'utf8').trim() || '0' }
            else 
            { pth_fan1_input = path.join('/sys', 'class', 'hwmon', 'hwmon1', 'fan1_input'); }
        }
        if (!fan1_input)
        {
            if (fs.existsSync(pth_fan1_input))
            { fan1_input = fs.readFileSync(pth_fan1_input, 'utf8').trim() || '0' }
            else 
            { pth_fan1_input = path.join('/sys', 'class', 'hwmon', 'hwmon2', 'fan1_input'); }
        }
        if (!fan1_input)
        {
            if (fs.existsSync(pth_fan1_input))
            { fan1_input = fs.readFileSync(pth_fan1_input, 'utf8').trim() || '0' }
            else 
            { pth_fan1_input = path.join('/sys', 'class', 'hwmon', 'hwmon3', 'fan1_input'); }
        }
        if (!fan1_input)
        {
            if (fs.existsSync(pth_fan1_input))
            { fan1_input = fs.readFileSync(pth_fan1_input, 'utf8').trim() || '0' }
            else 
            { pth_fan1_input = path.join('/sys', 'class', 'hwmon', 'hwmon4', 'fan1_input'); }
        }
        if (!fan1_input)
        {
            if (fs.existsSync(pth_fan1_input))
            { fan1_input = fs.readFileSync(pth_fan1_input, 'utf8').trim() || '0' }
            else 
            { pth_fan1_input = path.join('/sys', 'class', 'hwmon', 'hwmon5', 'fan1_input'); }
        }
        if (!fan1_input)
        {
            if (fs.existsSync(pth_fan1_input))
            { fan1_input = fs.readFileSync(pth_fan1_input, 'utf8').trim() || '0' }
            else 
            { fan1_input = '0'; }
        }
        fan1_input = Number(fan1_input);


        return {
            systemTime:         String(new Date()),
            osArchitecture:     String(os.arch),
            osUptime:           Number(os.uptime),
            freemem:            Number(os.freemem),
            totalmem:           Number(os.totalmem),
            hostname:           String(os.hostname),
            loadavg:            os.loadavg(),
            thermal:            {
                                    thermal_zone0,
                                    fan1_input
                                },
            osMachine:          String(os.machine),
            osPlatform:         String(os.platform),
            osRelease:          String(os.release),
            osVersion:          String(os.version),
            networkInterfaces:  os.networkInterfaces(),
            cpus:               os.cpus(),
        }
    }

    sendStats() {
        const stats = this.getSystemStats();

        this.ws_conn_stats.forEach((ws) => {
            ws.send(JSON.stringify(stats));
        });
    }

    async close() {
        this.closing = true;

        console.info(`[ CLOSING ][ ${path.basename(__filename).split('.')[0]} ]`);

        if (this.statsSendInterval)
        {
            clearInterval(this.statsSendInterval);
            this.statsSendInterval = null;
        }

        await Promise.all([
            new Promise((resolve) => {
                if (this.ws_conn_display.size !== 0)
                {
                    this.ws_serv_display.close((err) => {
                        if (err)
                        {
                            console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR CLOSING ] Overlay Display WebSocket`, err);
                            resolve();
                        }
                        else    
                        {
                            console.info(`[ -CLOSED ][ ${path.basename(__filename).split('.')[0]} ] Overlay Display WebSocket`);
                            resolve();
                        }
                    });
                    setTimeout(() => {
                        console.info(`[ -CLOSED ][ ${path.basename(__filename).split('.')[0]} ] Overlay Display WebSocket (Timeout)`);
                        resolve();
                    }, 1000);
                }
                else
                {
                    console.log(`[ -CLOSED ][ ${path.basename(__filename).split('.')[0]} ] Overlay Display WebSocket - NO Connections`);
                    resolve();
                }
            }),
            new Promise((resolve) => {
                if (this.ws_conn_system.size !== 0)
                {
                    this.ws_serv_system.close((err) => {
                        if (err)
                        {
                            console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR CLOSING ] System GUI WebSocket`, err);
                            resolve();
                        }
                        else
                        {
                            console.info(`[ -CLOSED ][ ${path.basename(__filename).split('.')[0]} ] System GUI WebSocket`);
                            resolve();
                        }
                    });
                    setTimeout(() => {
                        console.info(`[ -CLOSED ][ ${path.basename(__filename).split('.')[0]} ] System GUI WebSocket (Timeout)`);
                        resolve();
                    }, 1000);
                }
                else
                {
                    console.info(`[ -CLOSED ][ ${path.basename(__filename).split('.')[0]} ] System GUI WebSocket - NO Connections`);
                    resolve();
                }
            }),
            new Promise((resolve) => {
                if (this.ws_conn_stats.size !== 0)
                {
                    this.ws_serv_stats.close((err) => {
                        if (err)
                        {
                            console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR CLOSING ] System Stats WebSocket`, err);
                            resolve();
                        }
                        else
                        {
                            console.info(`[ -CLOSED ][ ${path.basename(__filename).split('.')[0]} ] System Stats WebSocket`);
                            resolve();
                        }
                    });
                    setTimeout(() => {
                        console.info(`[ -CLOSED ][ ${path.basename(__filename).split('.')[0]} ] System Stats WebSocket (Timeout)`);
                        resolve();
                    }, 1000);
                }
                else
                {
                    console.info(`[ -CLOSED ][ ${path.basename(__filename).split('.')[0]} ] System Stats WebSocket - NO Connections`);
                    resolve();
                }
            }),
            new Promise((resolve) => {
                if (this.ws_conn_sources.size !== 0)
                {
                    this.ws_serv_sources.close((err) => {
                        if (err)
                        {
                            console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR CLOSING ] NDI Source WebSocket`, err);
                            resolve();
                        }
                        else
                        {
                            console.info(`[ -CLOSED ][ ${path.basename(__filename).split('.')[0]} ] NDI Source WebSocket`);
                            resolve();
                        }
                    });
                    setTimeout(() => {
                        console.info(`[ -CLOSED ][ ${path.basename(__filename).split('.')[0]} ] NDI Source WebSocket (Timeout)`);
                        resolve();
                    }, 1000);
                }
                else
                {
                    console.info(`[ -CLOSED ][ ${path.basename(__filename).split('.')[0]} ] NDI Source WebSocket - NO Connections`);
                    resolve();
                }
            }),
        ]);
        
        await this._tryCloseDiscovery();

        return new Promise((resolve) => {
            try { this.Server.closeAllConnections(); }
            catch {}

            // try {
            this.Server.close((err) => {
                console.info(`[ -CLOSED ][ ${path.basename(__filename).split('.')[0]} ]`);
                resolve();
            });
            // }
            // catch {}
            // finally { 
            //     console.info(`[ -CLOSED ][ ${path.basename(__filename).split('.')[0]} ]`);
            //     resolve();
            // }
        });
    }

    /**
     * 
     * @param {Object}  message - Message object to send to Overlay Display
     * @param {string} [message.type] - Read by the overlay display as the message type.
     * @param {any}    [message.data] - Data to send. Type predefinded by Display WebSocket on basis of message.type.
     */
    sendUpdateToDisplay(message) {
        // let msg = {
        //     type: 'settings-update',
        //     data: Array.from(this.settings.fileMap),
        //     ...message,
        // };
        this.ws_conn_display.forEach(client => {
            try {
                client.send(JSON.stringify(Array.from(this.settings.fileMap)));
            }
            catch (e) {
                console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ]`, 'Unable to deliver WebSocket message.\n', msg, '\n', e);
            }
        });

        // setTimeout(() => {
        //     this.ws_conn_display.forEach(client => {
        //         try { client.send(JSON.stringify(msg)); }
        //         catch (e) { console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ ERROR ]`, 'Unable to deliver WebSocket message.\n', msg, '\n', e); }
        //     });
        // }, 100);
    }
}

module.exports = NDPiCommandServer_Client;