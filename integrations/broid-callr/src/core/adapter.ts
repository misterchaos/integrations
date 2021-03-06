import * as Promise from "bluebird";
import broidSchemas from "broid-schemas";
import { Logger } from "broid-utils";
import * as Callr from "callr";
import * as uuid from "node-uuid";
import * as R from "ramda";
import { Observable } from "rxjs/Rx";

import { IAdapterHTTPOptions, IAdapterOptions, ICallrWebHookEvent } from "./interfaces";
import Parser from "./parser";
import WebHookServer from "./webHookServer";

export default class Adapter {
  private serviceID: string;
  private token: string | null;
  private tokenSecret: string | null;
  private HTTPOptions: IAdapterHTTPOptions;
  private connected: boolean;
  private session: any;
  private parser: Parser;
  private logLevel: string;
  private username: string;
  private logger: Logger;
  private webhookServer: WebHookServer;

  constructor(obj?: IAdapterOptions) {
    this.serviceID = obj && obj.serviceID || uuid.v4();
    this.logLevel = obj && obj.logLevel || "info";
    this.token = obj && obj.token || null;
    this.tokenSecret = obj && obj.tokenSecret || null;
    this.username = obj && obj.username || "SMS";

    const HTTPOptions: IAdapterHTTPOptions = {
      host: "127.0.0.1",
      port: 8080,
      webhookURL: "http://127.0.0.1/",
    };
    this.HTTPOptions = obj && obj.http || HTTPOptions;
    this.HTTPOptions.host = this.HTTPOptions.host || HTTPOptions.host;
    this.HTTPOptions.port = this.HTTPOptions.port || HTTPOptions.port;
    this.HTTPOptions.webhookURL = this.HTTPOptions.webhookURL || HTTPOptions.webhookURL;
    this.HTTPOptions.webhookURL = this.HTTPOptions.webhookURL
      .replace(/\/?$/, "/");

    this.parser = new Parser(this.serviceID, this.logLevel);
    this.logger = new Logger("adapter", this.logLevel);
  }

  // Return list of users information
  public users(): Promise {
    return Promise.reject(new Error("Not supported"));
  }

  // Return list of channels information
  public channels(): Promise {
    return Promise.reject(new Error("Not supported"));
  }

  // Return the service ID of the current instance
  public serviceId(): String {
    return this.serviceID;
  }

  // Connect to Callr
  // Start the webhook server
  public connect(): Observable<Object> {
    if (this.connected) {
      return Observable.of({ type: "connected", serviceID: this.serviceId() });
    }
    this.connected = true;

    if (!this.token
      || !this.tokenSecret) {
      return Observable.throw(new Error("Credentials should exist."));
    }

    this.session = new Callr.api(this.token, this.tokenSecret);
    this.webhookServer = new WebHookServer(this.HTTPOptions, this.logLevel);
    this.webhookServer.listen();

    return Observable.fromPromise(new Promise((resolve, reject) => {
      this.session
        .call("webhooks.subscribe", "sms.mo",
          this.HTTPOptions.webhookURL, null)
        .success(() => resolve(true))
        .error((error) => {
          this.logger.warning(error);
          if (R.contains(error.message, ["TYPE_ENDPOINT_DUPLICATE", "HTTP_CODE_ERROR"])) {
            resolve(null);
          }
          reject(error);
        });
    })
    .then(() => ({ type: "connected", serviceID: this.serviceId() })));
  }

  public disconnect(): Promise {
    return Promise.reject(new Error("Not supported"));
  }

  // Listen "message" event from Callr
  public listen(): Observable<Object> {
    if (!this.session) {
      return Observable.throw(new Error("No session found."));
    }

    return Observable.fromEvent(this.webhookServer, "message")
      .mergeMap((event: ICallrWebHookEvent) => this.parser.normalize(event))
      .mergeMap((normalized) => this.parser.parse(normalized))
      .mergeMap((parsed) => this.parser.validate(parsed))
      .mergeMap((validated) => {
        if (!validated) { return Observable.empty(); }
        return Promise.resolve(validated);
      });
  }

  public send(data: Object): Promise {
    this.logger.debug("sending", { message: data });
    return broidSchemas(data, "send")
      .then(() => {
        const toNumber: string = R.path(["to", "id"], data)
          || R.path(["to", "name"], data);
        const type: string = R.path(["object", "type"], data);
        let content: string = R.path(["object", "content"], data)
          || R.path(["object", "name"], data);

        if (type === "Image" || type === "Video") {
          content = R.path(["object", "url"], data) || R.path(["object", "content"], data)
            || R.path(["object", "name"], data);
        }

        if (type === "Note" || type === "Image" || type === "Video") {
          return new Promise((resolve, reject) => {
            return this.session.call("sms.send", this.username, toNumber, content, null)
              .success(() => resolve({ type: "sended", serviceID: this.serviceId() }))
              .error((error) => reject(error));
          });
        }

        return Promise.reject(new Error("Note, Image, Video are only supported."));
      });
  }
}
