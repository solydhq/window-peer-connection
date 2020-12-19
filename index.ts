import {
  ipcMain,
  remote,
  ipcRenderer,
  BrowserWindow,
} from 'electron';
import { EventEmitter } from 'events';

export interface Client {
  name: string;
  window: BrowserWindow
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface Global {
      clients: Client[];
    }
  }
}

export enum WPCMessages {
  Log = 'wpc-log',
  Relay = 'wpc-relay',
  Offer = 'wpc-offer',
  Answer = 'wpc-answer',
  Candidate = 'wpc-candidate',
  End = 'wpc-end',
}

export enum WPCEvents {
  ReceivedTrack = 'received-track',
  ConnectionClosed = 'connection-closed',
}

export interface WPCOptions {
  onEnd?: () => void;
}

/**
  * The main process peer connection interface
  */
export const p2pChannel = {
  /**
    * Register a client to the peer connection channel.
    * @param {string} client - client format: {name: "name", window: windowObj}
    */
  addClient(client: Client): void {
    if (!global.clients) {
      global.clients = [];
    }
    global.clients.push(client);
  },

  /**
    * Remove a client from the peer connection channel.
    * @param {string} clientName - name of the client window
    */
  removeClient(clientName: string): void {
    if (global.clients) {
      global.clients = global.clients.filter(
        (client: Client) => client.name !== clientName,
      );
    }
  },

  /**
    * Close RPCPeerConnection of a specific client.
    * @param {string} clientName - name of the client window
    */
  closeClientConnection(clientName: string): void {
    if (global.clients) {
      const currentClient = global.clients.find((client) => client.name === clientName);
      currentClient?.window.webContents.send(WPCMessages.End);
    }
  },

  /**
    * Sets the ipc listeners for messages from renderer processes
    */
  initChannel(): void {
    ipcMain.on(WPCMessages.Log, logMessage);
    ipcMain.on(WPCMessages.Relay, relayMessage);
  },

  /**
    * Disposes message relay channel
    */
  dispose(): void {
    ipcMain.removeListener(WPCMessages.Log, logMessage);
    ipcMain.removeListener(WPCMessages.Relay, relayMessage);
    global.clients = [];
  },
};

function logMessage(event: Event, message: string) {
  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.log(message);
  }
}

function relayMessage(event: Event, args: any[]) {
  const receiverName = args[1];
  const message = args[2];
  const targetClient = global.clients.find((client) => client.name === receiverName);
  if (targetClient) {
    const targetWindow = targetClient.window;
    targetWindow.webContents.send(message, args);
  }
}

/**
  * Log in main process terminal
  */
function log(message: string) {
  ipcRenderer.send(WPCMessages.Log, message);
}

/**
  * Wrapper class for RTCPeerConnection between Electron windows
  * @param {string} windowName - name of the BrowserWindow containing the object
  * @param {WPCOptions} options - options for the window peer connection
  */
export class WindowPeerConnection extends EventEmitter {
  windowName: string;

  peerConnection?: RTCPeerConnection;

  remoteTrackSender?: RTCRtpSender;

  options: WPCOptions;

  constructor(
    windowName: string,
    options: WPCOptions = {},
  ) {
    super();
    this.peerConnection = new RTCPeerConnection();
    this.windowName = windowName;
    this.options = options;
    log(`${this.windowName}: peer connection object`);

    /**
      * Bind "this" to methods
      */
    this.sendMessage = this.sendMessage.bind(this);
    this.attachTrack = this.attachTrack.bind(this);
    this.removeTrack = this.removeTrack.bind(this);
    this.onReceivedTrack = this.onReceivedTrack.bind(this);
    this.sendTrack = this.sendTrack.bind(this);
    this.handleOffer = this.handleOffer.bind(this);
    this.handleAnswer = this.handleAnswer.bind(this);
    this.handleCandidate = this.handleCandidate.bind(this);
    this.handleLeave = this.handleLeave.bind(this);

    /**
      * RTCPeerConnection event handlers
      */
    ipcRenderer.on(WPCMessages.Offer, this.handleOffer);
    ipcRenderer.on(WPCMessages.Answer, this.handleAnswer);
    ipcRenderer.on(WPCMessages.Candidate, this.handleCandidate);
    ipcRenderer.on(WPCMessages.End, this.handleLeave);

    /**
      * On received remote MediaStreamTrack, dispatch an event.
      */
    this.peerConnection.ontrack = ({ track }) => {
      this.emit(WPCEvents.ReceivedTrack, track);
    };

    /**
      * Once ice candidate created, sends to all clients registered.
      */
    this.peerConnection.onicecandidate = (event) => {
      log(`${this.windowName}: iceCandidate created`);
      if (event.candidate) {
        const clients = remote.getGlobal('clients') as typeof global.clients;
        clients.forEach(
          (client) => {
            if (client.name !== this.windowName) {
              this.sendMessage(client.name, WPCMessages.Candidate, event.candidate);
            }
          },
        );
      }
    };

    /**
      * Ice candidate connection state change event.
      */
    this.peerConnection.oniceconnectionstatechange = () => {
      if (this.peerConnection) {
        log(`${this.windowName}: iceCandidateState change event: ${this.peerConnection.iceConnectionState}`);
      }
    };
  }

  /**
    * Sends message from main window to mircro window.
    */
  sendMessage(receiverName: string, message: string, data: unknown): void {
    ipcRenderer.send(WPCMessages.Relay, [
      this.windowName,
      receiverName,
      message,
      JSON.stringify(data),
    ]);
  }

  /**
    * Attaches MediaStreamTrack object to send to peers.
    */
  attachTrack(track: MediaStreamTrack): void {
    if (
      this.remoteTrackSender?.track &&
      this.remoteTrackSender.track.id === track.id
    ) {
      return;
    }

    this.remoteTrackSender = this.peerConnection?.addTrack(track);
  }

  /**
    * Removes MediaStreamTrack object attached previously.
    */
  removeTrack(): void {
    if (this.remoteTrackSender) this.peerConnection?.removeTrack(this.remoteTrackSender);
  }

  /**
    * Wrapper for receivedTrack event.
    */
  onReceivedTrack(callback: (track: MediaStreamTrack) => void): void {
    this.on(WPCEvents.ReceivedTrack, callback);
  }

  /**
    * Sends the local MediaStreamTrack to a registered peer.
    * @param {string} receiverName - name of the receiving BrowserWindow
    */
  async sendTrack(receiverName: string): Promise<void> {
    log(`${this.windowName}: createOffer start`);

    this.peerConnection?.createOffer({ offerToReceiveVideo: true })
      .then(async (offer) => {
        await this.peerConnection?.setLocalDescription(offer);
        this.sendMessage(receiverName, WPCMessages.Offer, offer);
      })
      .catch((error) => {
        log(`${this.windowName}: Error when creating an offer ${error}`);
      });
  }

  /**
    * Sends an offer to the target peer.
    */
  async handleOffer(event: Electron.IpcRendererEvent, args: any[]): Promise<void> {
    const senderName = args[0];
    const data = args[3];
    const offer: RTCSessionDescriptionInit = JSON.parse(data);

    log(`${this.windowName}: Setting remoteDescription`);
    await this.peerConnection?.setRemoteDescription(new RTCSessionDescription(offer));
    log(`${this.windowName}: remoteDescription set`);

    this.peerConnection?.createAnswer()
      .then(async (answer) => {
        await this.peerConnection?.setLocalDescription(answer);
        log(`${this.windowName}: Creating answer`);
        this.sendMessage(senderName, WPCMessages.Answer, answer);
      })
      .catch((error) => {
        log(`${this.windowName}: Error when creating an answer ${error}`);
      });
  }

  /**
    * Sends an answer to the target peer.
    */
  handleAnswer(event: Electron.IpcRendererEvent, args: any[]): void {
    const data = args[3];
    const answer: RTCSessionDescriptionInit = JSON.parse(data);
    log(`${this.windowName}: remoteDescription set: ${
      !!this.peerConnection?.remoteDescription} - ${this.peerConnection?.iceConnectionState}`);
    const interval = setInterval(() => {
      log(`${this.windowName}: remoteDescription set: ${
        !!this.peerConnection?.remoteDescription} - ${this.peerConnection?.iceConnectionState}`);
      switch (this.peerConnection?.iceConnectionState) {
        case 'checking':
        case 'connected':
          clearInterval(interval);
          this.peerConnection?.setRemoteDescription(new RTCSessionDescription(answer));
          break;
        default:
      }
    }, 100);
  }

  /**
    * Adds ice candidate received to the RTCPeerConnection object.
    */
  handleCandidate(event: Electron.IpcRendererEvent, args: any[]): void {
    const data = args[3];
    const candidate: RTCIceCandidateInit = JSON.parse(data);
    this.peerConnection?.addIceCandidate(new RTCIceCandidate(candidate));
  }

  /**
    * Close connection and nullify handlers.
    */
  handleLeave(): void {
    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection.ontrack = null;
      this.peerConnection.onicecandidate = null;
      this.peerConnection.oniceconnectionstatechange = null;
      this.peerConnection = undefined;
      this.remoteTrackSender = undefined;
    }

    ipcRenderer.removeListener(WPCMessages.Offer, this.handleOffer);
    ipcRenderer.removeListener(WPCMessages.Answer, this.handleAnswer);
    ipcRenderer.removeListener(WPCMessages.Candidate, this.handleCandidate);
    ipcRenderer.removeListener(WPCMessages.End, this.handleLeave);
    this.removeAllListeners(WPCEvents.ReceivedTrack);

    this.emit(WPCEvents.ConnectionClosed);
    if (this.options.onEnd) this.options.onEnd();
  }
}
