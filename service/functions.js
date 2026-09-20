const { setTimeout } = require('timers');
const net = require('net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');
const { exec, spawn } = require('node:child_process');

/**
 * @typedef  {Object}  FunctionResponse
 * @property {boolean} success - Indicates if the operation completed without errors.
 * @property {string}  message - A human-readable status message.
 * @property {Object|Array|null} data - The payload returned from the operation, if any.
 */

/**
 * @typedef  {Object}   ExecResponse
 * @property {boolean}  success - Indicates if the operation completed without errors.
 * @property {any}      data - The payload returned from the operation, if any.
 */

/**
 * @typedef  {Object}       CommandResponse
 * @property {string}       id - Tracking UUID.
 * @property {boolean}      success - Indicates if the operation completed without errors.
 * @property {number}       ts - Epoch timestamp generated at the beginning of the function.
 * @property {Object|any}   data - The payload returned from the operation, if any.
 */



/** ---- Export Functions ---- */

    async function checkCecCompliance() {
        // let responseCecCompliance = [];

        const handleLine = (line = '') => {
            let fileName = null;
            let writeValue = '';

            const splitLine = String(line).split(':');

            if (line.includes('Polling:') && !fileName)
            {
                fileName = 'output_display_cec_enabled';
                writeValue = String(splitLine[1] || '').trim() == 'OK' ? 'true' : 'false';
            }

            if (line.includes('CEC Version') && !fileName)
            {
                fileName = 'output_display_cec_version';
                if (!String(splitLine[1] || '').includes('Tx'))
                { writeValue = String(splitLine[1] || '').trim(); }
                else
                { writeValue = ''; }
            }

            if (line.includes('Physical Address') && !fileName)
            {
                fileName = 'output_display_cec_address';
                if (isNaN(Number(String(splitLine[1] || '').trim().replaceAll('.', ''))))
                { writeValue = '' }
                else
                { writeValue = String(Number(String(splitLine[1] || '').trim().replaceAll('.', ''))) }
            }

            if (line.includes('Power Status') && !fileName)
            {
                fileName = 'output_display_cec_status_power';
                if (!String(splitLine[1] || '').includes('Tx'))
                { writeValue = String(splitLine[1] || 'unknown').trim(); }
                else
                { writeValue = 'unknown'; }
            }

            if (fileName)
            { fs.writeFileSync(path.join(process.env.DATA_NDPI_PATH, fileName), writeValue, 'utf8'); }
        };

        await new Promise((resolve) => {
            const proc = spawn('cec-compliance', ['-s']);
            proc.stdout.on('data', (data) => {
                const output = String(data.toString()).replaceAll('\t', '');
                stdoutToArray(output).forEach((line) => {
                    if (line) { handleLine(line); }
                });
            });
            proc.once('exit', () => { resolve(); });
        });
    }

    /** 
     * **Process API Command**
     * 
     * ---
     * 
     * ### NDPi Function
     * 
     * @param {Object}  message - Message object from API. Required: 'type'
     * @param {string}  [message.id] 
     * @param {string}  [message.type]
     * @param {any}     [message.data]
     * 
     * @returns {Promise<CommandResponse>}
     * 
     * ```json
     * {
     *    "id":      "<Tracking UUID>",
     *    "success": "<Boolean>",
     *    "ts":      "<Epoch TS>",
     *    "data":    "<Object>"
     * }
     * ```
     */
    async function processCommand(message = {}) {
        let command = {
            id:     message?.id || '',  // UUID of command for tracking
            type:   message?.type,
            data:   message?.data,      // data can be of any type
        };

        let response = {
            id:         command.id,
            success:    false,
            ts:         Date.now(),
            data:       {}
        };

        let arry = [];

        if (!command.type)
        {
            response.data.message = "Missing 'type'";
            return response;
        }

        switch (command.type)
        {
            case 'ping':
                response.success = true;
                return response;

            // Visual Display
            case 'show-blank':
                try
                {
                    fs.writeFileSync(
                        path.join(process.env.DATA_NDPI_PATH, 'ndpi_status_no_source_display_mode'),
                        'blank',
                        'utf8'
                    );
                    response = await setNdi(command, response);
                }
                catch (error)
                {
                    response.data.message = error;
                    response.success = false;
                }
                return response;

            case 'show-overlay':
                try
                {
                    fs.writeFileSync(
                        path.join(process.env.DATA_NDPI_PATH, 'ndpi_status_no_source_display_mode'),
                        'overlay',
                        'utf8'
                    );
                    response = await setNdi(command, response);
                }
                catch (error)
                {
                    response.data.message = error;
                    response.success = false;
                }
                return response;

            case 'set-overlay':
                try { fs.writeFileSync(path.join(process.env.DATA_NDPI_PATH, 'media_overlay_image'), JSON.stringify(command.data, null, 2), 'utf8'); }
                catch (error)
                {
                    response.data.message = error;
                    response.success = false;
                }
                return response;
            
            case 'set-source':
                response = await setNdi(command, response);
                return response;
            
            case 'get-sources':
                const ndiDiscoverPath = `./${fs.readFileSync(path.join(process.env.DATA_NDPI_PATH, 'ndi_source_discovery_exec'), 'utf8')}`;
                await new Promise((resolve) => {
                    exec(ndiDiscoverPath, (error, stdout, stderr) => {
                        if (error)
                        {
                            console.error(`[ functions ] NDI Discovery Error`, stderr.toString());
                            arry.push(stdoutToArray(stderr));
                            response.data.message = arry.join(' << ');
                            response.success = false;
                            resolve();
                        }
                        else
                        {
                            response.data.sources = [];
                            if (stdout)
                            {
                                const stdoutArray = stdoutToArray(stdout);
                                for (const line of stdoutArray)
                                {
                                    const splitLine = line.split('^');
                                    response.data.sources.push({
                                        name: splitLine[1],
                                        url: splitLine[0],
                                    });
                                }
                            }
                            response.success = true;
                            resolve();
                        }
                    });
                });
                return response;

            // Physical Display
            case 'send-cec':
                try
                {
                    const f = await fetch('http://localhost:3080/api/v1/__internal/cec', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(command)
                    });
                    if (f.ok) { response.success = true }
                    else { response.success = false }
                }
                catch (error)
                {
                    response.data.message = error;
                    response.success = false;
                }
                return response;
            
            // Device
            case 'shutdown-device':
                try
                {
                    const f = await fetch('http://localhost:3080/api/v1/__internal/shutdown', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(command)
                    });
                    if (f.ok) { response.success = true }
                    else { response.success = false }
                }
                catch (error)
                {
                    response.data.message = error;
                    response.success = false;
                }
                return response;
            
            case 'reboot-device':
                try
                {
                    let f = await fetch('http://localhost:3080/api/v1/__internal/reboot', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(command)
                    });
                    if (f.ok) { response.success = true }
                    else { response.success = false }
                }
                catch (error)
                {
                    response.data.message = error;
                    response.success = false;
                }
                return response;
            
                // NOT Complete
                // This case is complete, but needs implemented.
            case 'rename-device':
                const commandData = command.data || null;
                if (typeof commandData === 'string')
                { fs.writeFileSync(path.join(process.env.DATA_NDPI_PATH, 'device_name'), commandData, 'utf8'); }
                response.success = true;
                return response;
            
            case 'set-setting':
                const setSetting = await updateSetting(command.data?.name || null, command.data?.value);
                response.success = setSetting.success;
                response.data.message = setSetting.message;
                return response;

            case 'get-settings':
                try
                {
                    const f = await fetch('http://localhost:3080/api/v1/__internal/get-settings', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(command)
                    });
                    if (f.ok)
                    {
                        response.success = true;
                        response.data = await f.json();
                    }
                    else { response.success = false }
                }
                catch (error)
                {
                    response.data.message = error;
                    response.success = false;
                }
                return response;

            case 'check-for-update':
                await checkForUpdate();
                response.success = true;
                return response;

            case 'install-update':
                const installUpdate = updateInstall();
                response.success = installUpdate.success;
                response.data.message = installUpdate.message;
                response.data.log = installUpdate.data;
                return response;

            // Default Fallback
            default:
                console.log('[ functions ] Unhandled Command Received', command.type);

                response.data.message = "Unknown 'type'";
                return response;
                break;
            // End of Command Handler
        };
    }

    
    /**
     * Async CLI exec() function
     * 
     * ---
     * 
     * ### NDPi Function
     * 
     * @param {string} command >**command**: CLI command to execute
     * @param {string|null} cwd >**cwd**: Modify the current working directory of the shell. *Default Directory*: **home / *user* / ndpi / sh** 
     * @param {Object|null} env >**env**: Additional environment variables to pass into the shell.
     * @returns {Promise<ExecResponse>} 
     * ```
     * {
     *   success: boolean,
     *   data: any[]
     * }
     * ```
     */
    async function exe(command, cwd, env = {}) {
        let response = {
            success: false,
            data: null
        };

        let options = {
            env: {
                ...process.env,
                ...env
            }
        }
        if (cwd) { options.cwd = cwd; }

        await new Promise((resolve) => {
            exec(command, options, (error, stdout, stderr) => {
                if (error)
                {
                    console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ exec(${command}) ][ ERROR ]`, stderr.toString().trim());
                    resolve(response);
                }
                else
                {
                    response.success = true;
                    response.data = stdoutToArray(stdout)
                    resolve(response);
                }
            });
        });

        return response;
    }

    /** GET LOCAL IP */
    async function getLocalIp(testForNetwork = false) {
        if (testForNetwork)
        {
            console.info('[ functions ] Waiting for network online...');
            await waitForNetwork();
        }
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces))
        {
            for (const iface of interfaces[name])
            {
                const isIPv4 = iface.family === 'IPv4' || iface.family === 4;
                if (isIPv4 && !iface.internal)
                { return iface.address || null }
            }
        }
        return null;
    }

    /** SET NDI SOURCE */
    /**
     * Set the target NDI source. This will trigger the fsWatcher to launch the NDI Stream.
     * @param {object} command - Command contains the source information and UUID of the command.
     * @param {string} [command.id] - UUID of the Command/Request. Used for tracking.
     * @param {string} [command.data] - The name of the NDI source to connect to.
     * @param {object} res - This function will overwrite an existing response object for API. Optional.
     * 
     * ---
     * 
     * ### NDPi Function
     * 
     */
    async function setNdi(command, res = {}) {
        let response = { ...res };
        try
        {
            const res = await fetch('http://localhost:3080/api/v1/__internal/ndi', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(command)
            });
            if (res.ok)
            {
                const data = await res.json();
                response.message = data?.message ?? 'OK';
                response.success = true
            }
            else { response.success = false }
        }
        catch (error)
        {
            response.data.message = error;
            response.success = false;
        }
        return response;
    }

    /**
     * Fade the volume from it's current level.
     * @param {number} level - Level to fade the volume to. Starting from it's current setpoint. [Range: 0 - 255]
     * @param {string} source - Description of where the function was called. For debugging.
     * 
     * ---
     * 
     * ### NDPi Function
     * 
     */
    async function fadeVolume(level, source = 'Default') {
        if (!level.toString()) return;
        const commandLine = `${path.join(__dirname, '..', 'sh', 'fade-volume')} ${level} "${source}"` ;
        return new Promise((resolve) => { exec(commandLine).once('exit', resolve); });
    }


    // NDI Window Actions
    /** 
     * ---
     * 
     * ### NDPi Function
     * 
     */
    async function minimizeWindow_NDI() {
        const pid = fs.readFileSync(path.join(process.env.DATA_NDPI_PATH, 'pid_ndi_player'), 'utf8').trim() || null;
        let response = false;
        // let cmd1 = await exe(`xdotool search --class 'gstreamer'`);
        let cmd1 = await exe(`xdotool search ${pid ? `--pid ${pid}` : `--class 'gstreamer'`}`);

        if (!cmd1.success)
        { return response; }

        if (Array.isArray(cmd1.data))
        {
            for (const windowId of cmd1.data)
            {
                const cmd2 = await exe(`xdotool windowminimize ${windowId}`);
                if (cmd2.success) { response = true; }
            }
        }
        return response;
    }
    
    /** 
     * ---
     * 
     * ### NDPi Function
     * 
     */
        async function raiseWindow_NDI() {
        const pid = fs.readFileSync(path.join(process.env.DATA_NDPI_PATH, 'pid_ndi_player'), 'utf8').trim() || null;
        let response = false;
        // let cmd1 = await exe(`xdotool search --class 'gstreamer'`);
        let cmd1 = await exe(`xdotool search ${pid ? `--pid ${pid}` : `--class 'gstreamer'`}`);

        if (!cmd1.success)
        { return response; }

        if (Array.isArray(cmd1.data))
        {
            for (const windowId of cmd1.data)
            {
                const cmd2 = await exe(`xdotool windowraise ${windowId}`);
                if (cmd2.success) { response = true; }
            }
        }
        return response;
    }

    /** 
     * ---
     * 
     * ### NDPi Function
     * 
     */
    async function activateWindow_NDI() {
        const pid = fs.readFileSync(path.join(process.env.DATA_NDPI_PATH, 'pid_ndi_player'), 'utf8').trim() || null;
        let response = false;
        // let cmd1 = await exe(`xdotool search --class 'gstreamer'`);
        let cmd1 = await exe(`xdotool search ${pid ? `--pid ${pid}` : `--class 'gstreamer'`}`);

        if (Array.isArray(cmd1.data))
        {
            for (const windowId of cmd1.data)
            {
                const cmd2 = await exe(`xdotool windowactivate ${windowId}`);
                if (cmd2.success) { response = true; }
            }
        }
        return response;
    }

    // AirPlay Window Activate
    /** 
     * ---
     * 
     * ### NDPi Function
     * 
     */
    async function activateWindow_AirPlay() {
        const pid = fs.readFileSync(path.join(process.env.DATA_NDPI_PATH, 'pid_air_play_player'), 'utf8').trim() || null;
        let response = false;
        let cmd1 = await exe(`xdotool search --pid ${pid}`);

        if (Array.isArray(cmd1.data))
        {
            for (const windowId of cmd1.data)
            {
                const cmd2 = await exe(`xdotool windowactivate ${windowId}`);
                if (cmd2.success) { response = true; }
            }
        }
        return response;
    }

    // Chromium Window Actions
    /** 
     * ---
     * 
     * ### NDPi Function
     * 
     */
    async function minimizeWindow_Chromium() {
        const pid = fs.readFileSync(path.join(process.env.DATA_NDPI_PATH, 'pid_chromium'), 'utf8').trim() || null;
        let response = false;
        let cmd1 = await exe(`xdotool search ${pid ? `--pid ${pid}` : `--class 'chromium'`}`);

        if (!cmd1.success)
        { return response; }

        if (Array.isArray(cmd1.data))
        {
            for (const windowId of cmd1.data)
            {
                const cmd2 = await exe(`xdotool windowminimize ${windowId}`);
                if (cmd2.success) { response = true; }
            }
        }
        return response;
    }

    /** 
     * ---
     * 
     * ### NDPi Function
     * 
     */
    async function raiseWindow_Chromium() {
        const pid = fs.readFileSync(path.join(process.env.DATA_NDPI_PATH, 'pid_chromium'), 'utf8').trim() || null;
        let response = false;
        let cmd1 = await exe(`xdotool search ${pid ? `--pid ${pid}` : `--class 'chromium'`}`);

        if (!cmd1.success)
        { return response; }

        if (Array.isArray(cmd1.data))
        {
            for (const windowId of cmd1.data)
            {
                const cmd2 = await exe(`xdotool windowraise ${windowId}`);
                if (cmd2.success) { response = true; }
            }
        }
        return response;
    }

    /** 
     * ---
     * 
     * ### NDPi Function
     * 
     */
    async function activateWindow_Chromium() {
        const pid = fs.readFileSync(path.join(process.env.DATA_NDPI_PATH, 'pid_chromium'), 'utf8').trim() || null;
        let response = false;
        let cmd1 = await exe(`xdotool search ${pid ? `--pid ${pid}` : `--class 'chromium'`}`);

        if (!cmd1.success)
        { return response; }

        if (Array.isArray(cmd1.data))
        {
            for (const windowId of cmd1.data)
            {
                const cmd2 = await exe(`xdotool windowactivate ${windowId}`);
                if (cmd2.success) { response = true; }
            }
        }
        return response;
    }

    /** 
     * ---
     * 
     * ### NDPi Function
     * 
     */
    async function launchPicom() {
        let picomNotRunning = false;
        await new Promise((resolve) => {
            exec('pgrep picom', (error, stdout, stderr) => {
                if (error) { picomNotRunning = true; }
                resolve();
            });
        });

        if (picomNotRunning)
        {
            // console.log('launching PICOM');
            await new Promise((resolve) => {
                exec(`picom -b --config "${process.env.HOME}/.config/picom/picom.conf"`, (error, stdout, stderr) => {
                    if (error)
                    { console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ]`, '[ PICOM ERROR ]', stderr.toString()); }
                    resolve();
                });
            });
            // console.log('PICOM launch');
        }
        return;
    }

    /** 
     * ---
     * 
     * ### NDPi Function
     * 
     */
    async function killPicom() {
        let picomRunning = false;

        await new Promise((resolve) => {
            exec('pgrep picom', (error, stdout, stderr) => {
                if (!error) { picomRunning = true; }
                resolve();
            });
        });

        if (picomRunning)
        { return await exe('killall picom'); }
        else 
        { return; }
    }

    /** 
     * ---
     * 
     * ### NDPi Function
     * 
     */
    async function activateDisplay() {
        await setDisplayResolution().catch();
        try
        {
            console.log(`[ ${path.basename(__filename).split('.')[0]} ][ activateDisplay() ] Attempting to activate display.`);

            const f2 = await fetch('http://localhost:3080/api/v1/__internal/cec', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: crypto.randomUUID, data: 'as' })
            });
            if (!f2.ok) { throw new Error(); }

            const data = await f2.json();
            if (!data.success) { throw new Error(); }
        }
        catch {}
    }

    /** STDOUT TO ARRAY */
    /**
     * **Convert line returns to an Array**
     * 
     * ---
     * 
     * ### NDPi Function
     * 
     * @param {string} stdout >**stdout**: Output from `node:child_process`
     * @returns {Array}
     */
    function stdoutToArray(stdout) {
        let a = [];
        let stdin = stdout.trim() || '';
        stdin.split(/\r?\n/).forEach((line) => {
            a.push(line);
        });
        return a;
    }

    /**
     * @async 
     * **Inline blocking tool**
     * 
     * ---
     * 
     * ### NDPi Function
     * 
     * @param {number} time > **time**: Wait time in *milliseconds*.
     */
    async function wait(time) {
        return new Promise((resolve) => { setTimeout(() => { resolve(); }, time || 0) });
    }

    /** SET DISPLAY RESOLUTION */
    /**
     * This function set's the HDMI output resolution
     * - Using these setting values:
     *   - 'output_display_port'
     *   - 'output_display_resolution_preference'
     * 
     * **⚠️ Use try / catch**
     * 
     * _This function will reject on failure with reason_
     * 
     * ---
     * 
     * ### NDPi Function
     * 
     */
    async function setDisplayResolution() {
        let config = {
            displayPort: 'HDMI-1',
            resolution: null,
            framerate: null,
        };

        try { config.displayPort = fs.readFileSync(path.join(process.env.DATA_NDPI_PATH, 'output_display_port'), 'utf8').trim() }
        catch {}

        try { config.resolution = fs.readFileSync(path.join(process.env.DATA_NDPI_PATH, 'output_display_resolution_preference'), 'utf8').trim() }
        catch {}
        
        try { config.framerate = fs.readFileSync(path.join(process.env.DATA_NDPI_PATH, 'output_display_framerate_preference'), 'utf8').trim() }
        catch {}

        return await new Promise((resolve, reject) => {
            if (config.displayPort == '')
            {
                // reject('No Display Port Configured');
                resolve()
                return;
            }
            exec(`xrandr \
                --output ${config.displayPort} \
                ${config.resolution ? `--mode ${config.resolution}` : '--auto'} \
                ${config.framerate ? `--rate ${config.framerate}` : ''} \
            `, {
                env: { ...process.env }
            }, (error, stderr) => {
                if (error)
                {
                    console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ setDisplayResolution() ][ ERROR ] Resolution Set:`, config, stderr);
                    resolve();
                    // reject(`XRandR Failed to set resolution. Reason: ${stderr.toString()}`);
                    return;
                }
                else
                {
                    exec('openbox --restart', {
                        env: { ...process.env }
                    }, (error, stdout, stderr) => {
                        if (error)
                        {
                            console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ setDisplayResolution() ][ ERROR ] Openbox Restart: ${stderr.toString()}`);
                            // reject(`Openbox Failed to restart after setting resolution. Reason: ${stderr.toString()}`);
                            resolve();
                            return;
                        }
                        resolve('');
                        return;
                    });
                }
            });
        });
    }

    /** 
     * ---
     * 
     * ### NDPi Function
     * 
     */
    async function getSetting(filename) {
        const response = {
            success: false,
            data: '',
        };

        if (!filename) { return response; }

        try
        {
            response.data = fs.readFileSync(path.join(process.env.DATA_NDPI_PATH, `${filename}`), 'utf8').trim();
            console.log('functions get setting ', filename, response.data);
            response.success = true
        }
        catch {}
        finally { return response; }
    }

    /** 
     * ---
     * 
     * ### NDPi Helper Function
     * 
     */
    async function waitForNetwork({ host = '8.8.8.8', port = 53, retryMs = 1000 } = {}) {
        return await new Promise((resolve) => {
            const tryConnect = () => {
                const socket = new net.Socket();
                socket.setTimeout(2000);
                socket.once('connect', () => {
                    const localIP = socket.localAddress;
                    socket.destroy();
                    NET_ONLINE = true;
                    resolve(localIP);
                });
                socket.once('timeout', () => {
                    socket.destroy();
                    setTimeout(tryConnect, retryMs);
                });
                socket.once('error', () => {
                    socket.destroy();
                    setTimeout(tryConnect, retryMs);
                });
                socket.connect(port, host);
            };
            tryConnect();
        });
    }


    /**
     * 
     * **Updates FS Setting**
     * 
     * Provide **'*name*'** and **'*value*'**
     * 
     * ---
     * 
     * #### NDPi Function
     * 
     * @param {string} name >**name**: Exact match to the fsSetting name.
     * @param {string} value >**value**: Value to write to the fsSetting. Must be of type string.
     * @returns {Promise<FunctionResponse>} 
     * 
     */
    async function updateSetting(name, value) {
        let response = {
            success: false,
            message: '',
        };

        if (!name || !value)
        {
            response.message = `Missing 'name' and/or 'value'.`;
            return response;
        }
        if (fs.existsSync(path.join(process.env.DATA_NDPI_PATH, name)))
        {
            const currentValue = fs.readFileSync(path.join(process.env.DATA_NDPI_PATH, name), 'utf8');
            if (currentValue === value)
            { response.message = 'Setting not modified. No change.'; }
            else
            {
                try
                {
                    fs.writeFileSync(path.join(process.env.DATA_NDPI_PATH, name), String(value), 'utf8');
                    response.message = `Successfully updated '${name}' from '${currentValue}' to '${value}'.`;
                    response.success = true;
                }
                catch (error)
                { response.message = `Failed to update setting: ${name}. Reason: ${error}`; }
            }
        }
        else
        { response.message = `Invalid setting: ${name}`; }
        return response;
    }

    /** 
     * ---
     * 
     * ### NDPi Function
     * 
     */
    async function checkForUpdate() {
        return new Promise((resolve) => {
            exec(path.join(__dirname, '..', 'sh', 'check-for-update'), (error, stdout) => {
                if (error)
                {
                    console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ checkForUpdate() ] Error when checking for update. {{ ./sh/check-for-update }}`);
                    resolve();
                }
                else
                {
                    const output = String(stdout.toString());
                    try
                    {
                        const update = JSON.parse(output);
                        console.log(`[ ${path.basename(__filename).split('.')[0]} ] Update Version Type: ${update.versionFrom || 'Not Defined'}`);
                        if (update.update_available)
                        { fs.writeFileSync(path.join(process.env.DATA_NDPI_PATH, 'ndpi_version_update_available'), String(update.update_available), 'utf8'); }
                        if (update.newest_version?.ndpi)
                        { fs.writeFileSync(path.join(process.env.DATA_NDPI_PATH, 'ndpi_version_update_version'), String(update.newest_version.ndpi), 'utf8'); }
                        if (update.newest_version?.released)
                        { fs.writeFileSync(path.join(process.env.DATA_NDPI_PATH, 'ndpi_version_update_version_date'), String(update.newest_version.released), 'utf8'); }
                    }
                    catch (err) { console.error(`⚠️   [ ${path.basename(__filename).split('.')[0]} ][ checkForUpdate() ] Error parsing update.`, err); }
                    finally
                    {
                        resolve();
                        return;
                    }
                }
            });
        });
    }
    
    /**
     *  **This function checks for the latest version by version number.**
     * 
     * 
     * | _`env.NODE_ENV`_       | _Action_                              |
     * | ---                    | ---                                   |
     * | ⎯⎯⎯⎯⎯⎯⎯⎯ | ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ |
     * | `PRODUCTION`           | → Compares `Stable Version` number    |
     * | `DEVELOPMENT`          | → Compares `Version` number           |
     * 
     * ---
     * 
     * @returns {boolean}
     * - `true` If Version numbers are _**different**_.
     * - `false` If Version numbers are _**matching**_.
     */
    async function checkVersion() {

    }
    
    /**
     * **Installs Update from GIT**
     * 
     * ---
     * 
     * #### NDPi Function
     * 
     * @returns {Promise<FunctionResponse>} 
     * 
     */
    async function updateInstall() {
        let response = {
            success: false,
            message: '',
        };
        await new Promise((resolve) => {
            exec(path.join(__dirname, '..', 'sh', 'install-update'), (error, stdout, stderr) => {
                if (error)
                {
                    response.message = stdoutToArray(stderr).join('. ').toString();
                    resolve();
                    return;
                }
                else
                {
                    response.data = stdoutToArray(stdout);
                    response.success = true;
                    response.message = 'Update Installed';
                    resolve();
                    return;
                }
            });
        });
        return response;
    }


module.exports = {
    processCommand,
    stdoutToArray,
    setDisplayResolution,
    checkCecCompliance,
    waitForNetwork,
    wait,
    exe,

    setNdi,
    fadeVolume,

    launchPicom,
    killPicom,

    updateSetting,
    checkForUpdate,
    updateInstall,

    minimizeWindow_Chromium,
    raiseWindow_Chromium,
    activateWindow_Chromium,
    
    minimizeWindow_NDI,
    raiseWindow_NDI,
    activateWindow_NDI,

    activateWindow_AirPlay,

    activateDisplay,
};