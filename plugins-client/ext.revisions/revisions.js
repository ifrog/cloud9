/**
 * Revisions Module for the Cloud9 IDE!
 *
 * @author Sergi Mansilla <sergi@c9.io>
 * @copyright 2012, Ajax.org B.V.
 */

define(function(require, exports, module) {

var ide = require("core/ide");
var ext = require("core/ext");
var editors = require("ext/editors/editors");
var menus = require("ext/menus/menus");
var tooltip = require("ext/tooltip/tooltip");
var commands = require("ext/commands/commands");

var Save = require("ext/save/save");
var Util = require("ext/revisions/revisions_util");
var settings = require("ext/settings/settings");
var markupSettings = require("text!ext/revisions/settings.xml");

// Ace dependencies
var EditSession = require("ace/edit_session").EditSession;
var Document = require("ace/document").Document;
var ProxyDocument = require("ext/code/proxydocument");

var markup = require("text!ext/revisions/revisions.xml");
var skin = require("text!ext/revisions/skin.xml");
var cssString = require("text!ext/revisions/style.css");

markup = markup.replace("{ide.staticPrefix}", ide.staticPrefix);

var beautify = require("ext/beautify/beautify");
var statusbar = require("ext/statusbar/statusbar");
var stripws = require("ext/stripws/stripws");
var language = require("ext/language/language");

var BAR_WIDTH = 200;
var INTERVAL = 60000;
var CHANGE_TIMEOUT = 500;

var isInfoActive = false;
module.exports = ext.register("ext/revisions/revisions", {
    name: "Revisions",
    dev: "Cloud9",
    alone: true,
    type: ext.GENERAL,
    markup: markup,
    offline: true,
    nodes: [],
    skin: skin,
    tempEnableAutoSave: false,
    isAutoSaveEnabled: false,

    /**
     * Revisions#rawRevisions -> Object
     * Holds the cached revisions and some meta-data about them so Cloud9 can
     * access them fast in the client-side. It also minimizes the amount of communication
     * needed with the server in single-user mode.
     */
    rawRevisions: {},
    docChangeTimeout: null,
    docChangeListeners: {},
    /**
     * Revisions#revisionQueue -> Object
     * Contains the revisions that have been sent to the server, but not yet
     * confirmed to be saved.
     */
    revisionQueue: {},

    /** related to: Revisions#onExternalChange
     * Revisions#changedPaths -> Array
     * Holds the list of filepaths that have ben changed in the server from an
     * external source.
     **/
    changedPaths: [],

    /** related to: Revisions#show
     * Revisions#toggle() -> Void
     *
     * Initializes the plugin if it is not initialized yet, and shows/hides its UI.
     **/
    toggle: function() {
        if (!editors.currentEditor.ceEditor) {
            return;
        }

        ext.initExtension(this);
        if (this.panel.visible)
            this.hide();
        else
            this.show();
    },

    hook: function() {
        var self = this;
        commands.addCommand({
            name: "revisionpanel",
            hint: "File Revision History...",
            bindKey: { mac: "Command-B", win: "Ctrl-B" },
            isAvailable: function(editor) {
                return editor && !!editor.ceEditor;
            },
            exec: function () {
                self.toggle();
            }
        });

        this.nodes.push(
            this.mnuSave = new apf.menu({ id: "mnuSave" }),
            menus.addItemByPath("File/~", new apf.divider(), 800),
            menus.addItemByPath("File/File Revision History...", new apf.item({
                type: "check",
                checked: "[{require('ext/settings/settings').model}::general/@revisionsvisible]",
                disabled: "{!tabEditors.length}",
                command: "revisionpanel"
            }), 900),
            menus.addItemByPath("File/~", new apf.divider(), 910)
        );

        ide.addEventListener("init.ext/tabbehaviors/tabbehaviors", function() {
            menus.addItemByPath("~", new apf.divider(), 2000, mnuContextTabs);
            menus.addItemByPath("File Revision History...", new apf.item({
                command : "revisionpanel"
            }), 2100, mnuContextTabs);
        });

        ide.addEventListener("init.ext/code/code", function() {
            self.nodes.push(
                mnuCtxEditor.insertBefore(new apf.item({
                    id : "mnuCtxEditorRevisions",
                    caption : "File Revision History...",
                    command: "revisionpanel"
                }), mnuCtxEditorCut),
                mnuCtxEditor.insertBefore(new apf.divider({
                    visible : "{mnuCtxEditorRevisions.visible}"
                }), mnuCtxEditorCut)
            );
        });
        settings.addSettings("General", markupSettings);
        ide.addEventListener("settings.load", function(e){
            e.ext.setDefaults("general", [["autosaveenabled", "false"]]);
            self.isAutoSaveEnabled = apf.isTrue(e.model.queryValue("general/@autosaveenabled")) || self.tempEnableAutoSave;
        });

        ide.addEventListener("settings.save", function(e) {
            if (!e.model.data)
                return;

            self.isAutoSaveEnabled = apf.isTrue(e.model.queryValue("general/@autosaveenabled")) || self.tempEnableAutoSave;
        });

        // Remove the revision file if the file is removed.
        ide.addEventListener("removefile", function(data) {
            ide.send({
                command: "revisions",
                subCommand: "removeRevision",
                isFolder: data.isFolder,
                path: Util.stripWSFromPath(data.path)
            });
        });

        // Rename/move the revision file if the file is renamed/moved
        ide.addEventListener("updatefile", function(data) {
            if (data && data.path && data.newPath) {
                var path = Util.stripWSFromPath(data.path);
                var newPath = Util.stripWSFromPath(data.newPath);

                // Remove reference by path to old path in `rawRevisions and
                // create reference with the new path.
                if (self.rawRevisions[path]) {
                    self.rawRevisions[newPath] = self.rawRevisions[path];
                    delete self.rawRevisions[path];
                }

                ide.send({
                    command: "revisions",
                    subCommand: "moveRevision",
                    path: path,
                    newPath: newPath
                });
            }
        });

        btnSave.setAttribute("caption", "");
        btnSave.setAttribute("margin", "0 20");
        btnSave.removeAttribute("tooltip");
        btnSave.removeAttribute("command");
        apf.setStyleClass(btnSave.$ext, "btnSave");

        tooltip.add(btnSave, {
            message : "Changes to your file are automatically saved.<br />\
                View all your changes through <a href='javascript:void(0)' \
                onclick='require(\"ext/revisions/revisions\").toggle();' \
                class='revisionsInfoLink'>the Revision History pane</a>. \
                Rollback to a previous state, or make comparisons.",
            width : "250px",
            hideonclick : true
        });

        // Declaration of event listeners
        this.$onMessageFn = this.onMessage.bind(this);
        this.$onOpenFileFn = this.onOpenFile.bind(this);
        this.$onCloseFileFn = this.onCloseFile.bind(this);
        this.$onFileSaveFn = this.onFileSave.bind(this);
        this.$onAfterOnline = this.onAfterOnline.bind(this);
        this.$onRevisionSaved = this.onRevisionSaved.bind(this);
        this.$onExternalChange = this.onExternalChange.bind(this);
        this.$onBeforeSaveWarning = this.onBeforeSaveWarning.bind(this);

        ide.addEventListener("socketMessage", this.$onMessageFn);
        ide.addEventListener("afteropenfile", this.$onOpenFileFn);
        ide.addEventListener("afterfilesave", this.$onFileSaveFn);
        ide.addEventListener("closefile", this.$onCloseFileFn);
        ide.addEventListener("afteronline", this.$onAfterOnline);
        ide.addEventListener("revisionSaved", this.$onRevisionSaved);
        ide.addEventListener("beforewatcherchange", this.$onExternalChange);
        ide.addEventListener("beforesavewarn", this.$onBeforeSaveWarning);

        this.defaultUser = { email: null };

        // This is the main interval. Whatever it happens, every `INTERVAL`
        // milliseconds, the plugin will attempt to save every file that is
        // open and dirty.
        this.saveInterval = setInterval(this.doAutoSave.bind(this), INTERVAL);

        // Retrieve the current user email in case we are not in Collab mode
        // (where we can retrieve the participants' email from the server) or
        // in OSS Cloud9.
        if (window.cloud9config.hosted || !this.isCollab()) {
            if (ide.loggedIn) {
                apf.ajax("/api/context/getemail", {
                    method: "get",
                    callback: function(data, state, extra) {
                        if (state === 200 && data) {
                            self.defaultUser = {
                                email: data
                            };
                        }
                    }
                });
            }
        }

        // Contains the revisions that have been saved during Cloud9 being offline.
        // Its items are not revision objects, but hold their own format (for
        // example, they have a generated timestamp of the moment of saving).
        if (localStorage.offlineQueue) {
            try {
                this.offlineQueue = JSON.parse(localStorage.offlineQueue);
            } catch(e) {
                console.error("Error loading revisions from local storage", e);
                this.offlineQueue = [];
            }
        }
        else {
            this.offlineQueue = [];
        }

        this.$initWorker();
    },

    $initWorker: function() {
        var worker = this.worker = new Worker(ide.workerPrefix + "/ext/revisions/revisions_worker.js");
        worker.onmessage = this.onWorkerMessage.bind(this);
        worker.onerror = function(error) {
            throw(new Error("Error from worker:\n" + error.message));
        };
        // Preload diff libraries so they are available to the worker in case we
        // go offline.
        worker.postMessage({ type: "preloadlibs", prefix: ide.workerPrefix });
    },

    setSaveButtonCaption: function(page) {
        if (!self.btnSave)
            return;

        var SAVING = 0;
        var SAVED = 1;

        btnSave.show();
        var page = page || tabEditors.getPage();
        if (page) {
            var hasChanged = Util.pageHasChanged(page);
            if (this.isAutoSaveEnabled && hasChanged) {
                if (btnSave.currentState !== SAVING) {
                apf.setStyleClass(btnSave.$ext, "saving", ["saved"]);
                apf.setStyleClass(document.getElementById("saveStatus"), "saving", ["saved"]);
                    btnSave.currentState = SAVING;
                    btnSave.setCaption("Saving");
                }
            }
            else if (!hasChanged) {
                if (btnSave.currentState !== SAVED) {
                apf.setStyleClass(btnSave.$ext, "saved", ["saving"]);
                apf.setStyleClass(document.getElementById("saveStatus"), "saved", ["saving"]);
                    btnSave.currentState = SAVED;
                    btnSave.setCaption("Changes saved");
                }
            }
        }
        else {
        btnSave.setCaption("");
        }
    },

    init: function() {
        var self = this;
        var page = tabEditors.getPage();
        if (page) {
            this.$switchToPageModel(page);
        }

        apf.importCssString(cssString);

        this.nodes.push(this.panel = new apf.bar({
                id: "revisionsPanel",
                visible: false,
                top: 6,
                bottom: 0,
                right: 0,
                width: BAR_WIDTH,
                height: "100%",
                "class": "revisionsBar"
            })
        );

        ide.addEventListener("init.ext/code/code", function(e) {
            self.panel = ceEditor.parentNode.appendChild(self.panel);
            revisionsPanel.appendChild(pgRevisions);
        });

        apf.addEventListener("exit", function() {
            localStorage.offlineQueue = JSON.stringify(self.offlineQueue);
        });

        this.$afterSelectFn = this.afterSelect.bind(this);
        lstRevisions.addEventListener("afterselect", this.$afterSelectFn);

        this.$onSwitchFileFn = this.onSwitchFile.bind(this);
        ide.addEventListener("tab.beforeswitch", this.$onSwitchFileFn);

        this.$onAfterSwitchFn = this.onAfterSwitch.bind(this);
        ide.addEventListener("tab.afterswitch", this.$onAfterSwitchFn);

        this.$afterModelUpdate = this.afterModelUpdate.bind(this);

        this.$setRevisionListClass();
    },

    $switchToPageModel: function(page) {
        if (!page || !Util.pageIsCode(page)) {
            return;
        }

        if (!page.$mdlRevisions) {
            page.$mdlRevisions = new apf.model();
        }

        // Commented the line below out because it would try to select
        // and update nodes in the cached representation.
        //this.$restoreSelection(page, page.$mdlRevisions);
        this.model = page.$mdlRevisions;
        this.model.addEventListener("afterload", this.$afterModelUpdate);
        return this.model;
    },

    $restoreSelection: function(page, model) {
        if (page.$showRevisions === true && window.lstRevisions && !this.isNewPage(page)) {
            var selection = lstRevisions.selection;
            var node = model.data.firstChild;
            if (selection && selection.length === 0 && page.$selectedRevision) {
                node = model.queryNode("revision[@id='" + page.$selectedRevision + "']");
            }
            lstRevisions.select(node);
        }
    },

    $getRevisionObject: function(path) {
        var revObj = this.rawRevisions[path];
        if (!revObj) {
            revObj = this.rawRevisions[path] = {};
            revObj.useCompactList = true;
            revObj.groupedRevisionIds = [];
            revObj.previewCache = {};
        }
        return revObj;
    },

    hideRevisionsInfo : function() {
        if (!isInfoActive && window.revisionsInfo) {
            setTimeout(function(e) {
                if (!isInfoActive) {
                    apf.tween.single(revisionsInfo, {
                        from:1,
                        to:0,
                        steps: 10,
                        type     : "opacity",
                        anim     : apf.tween.easeInOutCubic,
                        interval: 30
                    });
                }
            }, 200);
        }
    },

    /////////////////////
    // Event listeners //
    /////////////////////

    /** related to: Revisions#showQuestionWindow
     * Revisions#onExternalChange(e) -> Boolean
     * - e(Object): Event object
     *
     * This is the listener to the file watcher event. It is fired when a file is
     * modified by an external application, and it starts the chain of messaging
     * events, starting with asking the server to send over the contents of the
     * modified file as it is after the external changes.
     **/
    onExternalChange: function(e) {
        // We want to prevent autosave to keep saving while we are resolving
        // this query.
        this.prevAutoSaveValue = this.isAutoSaveEnabled;
        settings.model.setQueryValue("general/@autosaveenabled", false);

        var path = Util.stripWSFromPath(e.path);
        this.changedPaths.push(path);

        // Force initialization of extension (so that UI is available)
        ext.initExtension(this);

        if (winQuestionRev.visible !== true && !this.isCollab()) { // Only in single user mode
            ide.send({
                command: "revisions",
                subCommand: "getRealFileContents",
                path: path
            });
        }
        return false;
    },

    onBeforeSaveWarning: function(e) {
        var isNewFile = apf.isTrue(e.doc.getNode().getAttribute("newfile"));
        if (!isNewFile && this.isAutoSaveEnabled) {
            this.save();
            return false;
        }
    },

    onOpenFile: function(data) {
        if (!data || !data.doc)
            return;

        var self = this;
        var doc = data.doc;
        var page = doc.$page;
        if (!page || !Util.pageIsCode(page)) {
            return;
        }

        // Add document change listeners to an array of functions so that we
        // can clean up on disable plugin.
        var path = Util.getDocPath(page);
        if (path && !this.docChangeListeners[path]) {
            this.docChangeListeners[path] = function(e) {
                self.onDocChange.call(self, e, doc);
            };
        }

        this.$switchToPageModel(page);
        if (!this.isNewPage(page)) {
            ide.send({
                command: "revisions",
                subCommand: "getRevisionHistory",
                path: path
            });

            this.setSaveButtonCaption();
        }
        (doc.acedoc || doc).addEventListener("change", this.docChangeListeners[path]);
    },

    onSwitchFile: function(e) {
        this.$switchToPageModel(e.nextPage);
    },

    onAfterSwitch: function(e) {
        if (!Util.pageIsCode(e.nextPage)) {
            return;
        }

        if (e.nextPage.$showRevisions === true) {
            return this.show();
        }

        return this.hide();
    },

    onFileSave: function(e) {
        this.saveRevision(e.doc, e.silentsave);
    },

    onCloseFile: function(e) {
        if (tabEditors.getPages().length == 1)
            btnSave.hide();
        else
            this.setSaveButtonCaption(e.page);

        var self = this;
        setTimeout(function() {
            var path = Util.getDocPath(e.page);
            if (self.rawRevisions[path]) {
                delete self.rawRevisions[path];
            }

            if (self.docChangeListeners[path]) {
                delete self.docChangeListeners[path];
            }

            self.worker.postMessage({
                type: "closefile",
                path: path
            });

            for (var rev in self.revisionQueue) {
                var _path = self.revisionQueue[rev].path;
                if (_path && _path === path) {
                    delete self.revisionQueue[rev];
                }
            }
        }, 100);

        this.save(e.page);
    },

    $makeNewRevision: function(rev) {
        var revObj = this.$getRevisionObject(rev.path);
        rev.revisions = revObj.allRevisions;
        this.worker.postMessage(rev);
    },

    onRevisionSaved: function(data) {
        var savedTS = parseInt(data.ts, 10);
        var matches = this.offlineQueue.filter(function(rev) {
            return rev && (parseInt(rev.applyOn, 10) === savedTS);
        });

        if (matches.length) {
            this.$makeNewRevision(matches[0]);
        }
    },

    onAfterOnline: function(e) {
        if (!this.offlineQueue.length) {
            return;
        }

        this.offlineQueue.forEach(function(rev, ind, _queue) {
            var prev = _queue[ind - 1];
            if (prev) {
                rev.applyOn = prev.ts;
            }
        });
        this.$makeNewRevision(this.offlineQueue.shift()); // First item doesn't depend on anything

        localStorage.offlineQueue = "[]"; // Empty local storage
        this.offlineQueue = [];
    },

    afterSelect: function(e) {
        var node = e.currentTarget.selected;
        if (!node || e.currentTarget.selection.length > 1) {
            return;
        }

        var revObj = this.$getRevisionObject(Util.getDocPath());
        var id = parseInt(node.getAttribute("id"), 10);
        var cache = revObj.previewCache;
        if (cache[id]) {
            this.previewRevision(id, null, cache[id][1], cache[id][0]);
        }
        else {
            this.loadRevision(id, "preview");
        }
        tabEditors.getPage().$selectedRevision = id;
    },

    // Gets called twice. Why??
    afterModelUpdate: function(e) {
        var model = e.currentTarget;
        if (!model || !model.data || model.data.childNodes.length === 0) {
            return;
        }

        if (typeof lstRevisions !== "undefined") {
            lstRevisions.setModel(model);
            this.$restoreSelection(tabEditors.getPage(), model);
        }
    },

    onDocChange: function(e, doc) {
        if (e.data && e.data.delta) {
            var suffix = e.data.delta.suffix;
            var user = this.getUser(suffix, doc);
            if (suffix && user) {
                this.addUserToDocChangeList(user, doc);
            }
        }

        var page = doc.$page;
        if (page && this.isAutoSaveEnabled && !this.isNewPage(page)) {
            var self = this;
            setTimeout(function() {
                self.setSaveButtonCaption();
            });

            clearTimeout(this.docChangeTimeout);
            this.docChangeTimeout = setTimeout(function(self) {
                stripws.disable();
                self.save(page);
            }, CHANGE_TIMEOUT, this);
        }
    },

    onWorkerMessage: function(e) {
        if (!e.data.type)
            return;

        switch (e.data.type) {
            case "apply":
                this.applyRevision(e.data.content.id, e.data.content.value);
                break;
            case "preview":
                var content = e.data.content;
                this.previewRevision(content.id, content.value, content.ranges);
                break;
            case "newRevision":
                var revision = e.data.revision;
                // We don't save revision if it doesn't contain any patches
                // (i.e. nothing new was saved)
                if (revision.patch[0].length === 0) {
                    return;
                }

                this.revisionQueue[revision.ts] = {
                    path: e.data.path,
                    revision: revision
                };

                this.$saveExistingRevision(e.data.path, revision);
                break;
            case "newRevision.error":
                var revObj = this.$getRevisionObject(e.data.path);
                if (revObj) {
                    revObj.hasBeenSentToWorker = false;
                }
                break;
            case "recovery":
                if (e.data.revision.nextAction === "storeAsRevision") {
                    var c9DocContent = e.data.revision.finalContent;

                    // No need to send these over the wire.
                    delete e.data.revision.finalContent;
                    delete e.data.revision.realContent;

                    var path, page;
                    var pages = tabEditors.getPages();
                    for (var i = 0; i < pages.length; i++) {
                        page = pages[i];
                        path = Util.stripWSFromPath(page.$model.data.getAttribute("path"));
                        if (e.data.path === path) {
                            page.$doc.setValue(c9DocContent);
                            break;
                        }
                    }

                    ide.send({
                        command: "revisions",
                        subCommand: "saveRevision",
                        path: e.data.path,
                        revision: e.data.revision,
                        forceRevisionListResponse: true
                    });
                }
                else if (e.data.revision.inDialog === true && winQuestionRev.visible !== true) {
                    this.showQuestionWindow(e.data);
                }
                break;
            case "debug":
                console.log("WORKER DEBUG\n", e.data.content);
                break;
        }
    },

    $saveExistingRevision: function(path, revision) {
        ide.send({
            command: "revisions",
            subCommand: "saveRevision",
            path: path,
            revision: revision
        });
    },

    onMessage: function(e) {
        var self = this;
        var message = e.message;
        if (message.type !== "revision") {
            return;
        }

        var page = tabEditors.getPage();
        var revObj = this.$getRevisionObject(message.path);

        // guided tour magic conflicts with revisions--skip it
        if (page && page.$model.data.getAttribute("guidedtour") === "1")
            return;

        switch (message.subtype) {
            case "confirmSave":
                var ts = message.ts;
                // This could happen in edge cases, like the user having two browsers
                // opened and active on the same file, and then saving. Only one
                // of them will have the revision in the queue (in single user mode).
                // In that case, we understand that there is some problem and
                // request the entire revision history to the server.
                if (!this.revisionQueue[ts]) {
                    ide.send({
                        command: "revisions",
                        subCommand: "getRevisionHistory",
                        path: message.path,
                        id: ts
                    });
                    return;
                }

                var revision = this.revisionQueue[ts].revision;
                if (revision) {
                    revision.saved = true;
                    // In the case that a new file has just been created and saved
                    // `allRevisions` won't be there (since there has never been
                    // a `getRevisionhistory` that creates it), so we create it.
                    if (!revObj.allRevisions) {
                        revObj.allRevisions = {};
                    }

                    revObj.allRevisions[ts] = revision;
                    delete this.revisionQueue[ts];

                    this.generateCompactRevisions(revObj);
                    ide.dispatchEvent("revisionSaved", {
                        ts: ts,
                        path: message.path,
                        revision: revision
                    });

                    // The following code inserts the confirmed revision as the
                    // first (most recent) revision in the list, only if the model
                    // has been populated before already
                    var revisionString = this.getXmlStringFromRevision(revision);
                    var page = tabEditors.getPage(ide.davPrefix + "/" + message.path);
                    if (page) {
                            var model = page.$mdlRevisions;
                            if (model && model.data && model.data.childNodes.length) {
                            var revisionNode = apf.getXml(revisionString);
                            apf.xmldb.appendChild(model.data, revisionNode, model.data.firstChild);
                            }
                    }
                }
                break;

            case "getRevisionHistory":
                if (message.body && message.body.revisions) {
                    revObj.allRevisions = message.body.revisions;
                }

                this.generateCompactRevisions(revObj);
                if (!message.nextAction || !message.id) {
                    if (page && Util.getDocPath(page) === message.path &&
                        page.$showRevisions === true) {
                        this.populateModel(revObj, this.model);
                    }
                    break;
                }

                var data = {
                    id: message.id,
                    group: {},
                    type: message.nextAction
                };

                var len = revObj.groupedRevisionIds.length;
                if (revObj.useCompactList && len > 0) {
                    for (var i = 0; i < len; i++) {
                        var groupedRevs = revObj.groupedRevisionIds[i];
                        if (groupedRevs.indexOf(parseInt(message.id, 10)) !== -1) {
                            groupedRevs.forEach(function(ts) {
                                data.group[ts] = this.getRevision(ts);
                            }, this);
                            break;
                        }
                    }

                    if (Object.keys(data.group).length > 1) {
                        this.worker.postMessage(data);
                        break;
                    }
                }

                data.group[message.id] = this.getRevision(message.id);
                this.worker.postMessage(data);
                break;

            case "getRealFileContents":
                var pages = tabEditors.getPages();
                pages.forEach(function(page) {
                    var path = Util.stripWSFromPath(page.$model.data.getAttribute("path"));
                    if (message.path === path) {
                        var data = {
                            inDialog: true,
                            type: "recovery",
                            lastContent: page.$doc.getValue(),
                            realContent: message.contents,
                            path: message.path
                        };

                        if (message.nextAction === "storeAsRevision") {
                            data.nextAction = "storeAsRevision";
                        }
                        self.worker.postMessage(data);
                    }
                });
                break;

            case "serverError":
                if (console && console.error)
                    console.error("Server error in " + message.body.fromMethod + ": " + message.body.msg);
        }
    },

    /**
     * Revisions#showQuestionWindow(data) -> Void
     * - data (Object): Data about the revision to be potentially submitted, and
     * the contents of the file before and after the external edit.
     *
     * Shows a dialog that lets the user choose whether to keep the current state
     * of the document or to reload it to get the external changes.
     **/
    showQuestionWindow: function(data) {
        if (typeof winQuestionRev === "undefined") {
            return;
        }

        // No need to send these over the wire.
        delete data.revision.finalContent;
        delete data.revision.realContent;

        var self = this;
        var finalize = function() {
            self.changedPaths = [];
            winQuestionRev.hide();
            settings.model.setQueryValue("general/@autosaveenabled", this.prevAutoSaveValue || true);
        };

        // Reload page if it has been changed. Once reloaded, the page is saved
        // with the new content.
        var reloadAndSave = function(_page) {
            var path = Util.stripWSFromPath(_page.$model.data.getAttribute("path"));
            var index = self.changedPaths.indexOf(path);
            if (self.changedPaths.indexOf(path) > -1) {
                ide.addEventListener("afterreload", function onDocReload(e) {
                    if (e.doc === _page.$doc) {
                        // doc.setValue is redundant here, but it ensures that
                        // the proper value will be saved.
                        e.doc.setValue(e.data);
                        setTimeout(function() {
                            self.save(_page, true);
                        });
                        ide.removeEventListener("afterreload", onDocReload);
                    }
                });
                ide.dispatchEvent("reload", { doc : _page.$doc });
            }
            return index;
        };

        var dontReloadAndStore = function(_page) {
            var path = Util.stripWSFromPath(_page.$model.data.getAttribute("path"));
            var index = self.changedPaths.indexOf(path);
            if (index > -1) {
                ide.send({
                    command: "revisions",
                    subCommand: "getRealFileContents",
                    path: path,
                    nextAction: "storeAsRevision"
                });
            }
            return index;
        };

        var pages = tabEditors.getPages();
        Util.question(
            "File changed, reload tab?",
            "'" + data.path + "' has been modified while you were editing it.",
            "Do you want to reload it?",
            function YesReloadAll() {
                pages.forEach(reloadAndSave);
                setTimeout(finalize);
            },
            function NoDontReloadAll() {
                pages.forEach(dontReloadAndStore);
                setTimeout(finalize);
            }
        );
    },

    toggleListView: function(model) {
        var revObj = this.$getRevisionObject(Util.getDocPath());
        revObj.useCompactList = !revObj.useCompactList;

        // We don't want to mix up compact/detailed preview caches
        revObj.previewCache = {};
        this.$setRevisionListClass();

        // Select first child upon change of list view
        setTimeout(function() {
            var node = model.data.firstChild;
            if (node) {
                lstRevisions.select(node);
            }
        });
    },

    /**
     * Revisions#populateModel()
     *
     * Populates the revisions model with the current revision list and attributes.
     **/
    populateModel: function(revObj, model) {
        var page = tabEditors.getPage();
        if (this.isNewPage(page) || !Util.pageIsCode(page)) {
            return;
        }

        if (!revObj || !model) {
            console.error("Expected a parameter and a model");
            return;
        }

        var revisions;
        if (revObj.useCompactList && revObj.compactRevisions) {
            revisions = revObj.compactRevisions;
        }
        else {
            revisions = revObj.allRevisions;
        }

        var timestamps = Util.keysToSortedArray(revisions);
        var revsXML = "";
        for (var i = timestamps.length - 1; i >= 0; i--) {
            revsXML += this.getXmlStringFromRevision(revisions[timestamps[i]]);
        }
        this.model.load("<revisions>" + revsXML + "</revisions>");
    },

    getXmlStringFromRevision: function(revision) {
        if (!revision) { return; }

        var contributorToXml = function(c) {
            return "<contributor email='" + c + "' />";
        };

        var friendlyDate = (new Date(revision.ts)).toString("MMM d, h:mm tt");
        var restoring = revision.restoring || "";

        var xmlString = "<revision " +
                "id='" + revision.ts + "' " +
                "name='" + friendlyDate + "' " +
                "silentsave='" + revision.silentsave + "' " +
                "restoring='" + restoring + "'>";

            var contributors = "";
        if (revision.contributors && revision.contributors.length) {
            contributors = revision.contributors.map(contributorToXml).join("");
        }

        xmlString += "<contributors>" + contributors + "</contributors></revision>";
        return xmlString;
    },

    /**
     * Revisions#isCollab(doc) -> Boolean
     * - doc(Object): Document object
     *
     * Returns true if this document is part of a collaborations session, false
     * otherwise
     **/
    isCollab: function(doc) {
        if(!doc && !tabEditors.getPage())
            return false;

        var doc = (doc || tabEditors.getPage().$doc);
        return doc.acedoc.doc.$isTree;
    },

    /**
     * Revisions#iAmMaster(path) -> Boolean
     * - path(String): Path for the document to be checked
     *
     * Returns true if the current user is the "master" document in a collab
     * session. That means that the contents of his document will be the ones
     * saved in the collab session.
     **/
    iAmMaster: function(path) {
        // Has to be implemented.
        return true;
    },

    getRevision: function(id, content) {
        id = parseInt(id, 10);

        var revObj = this.$getRevisionObject(Util.getDocPath());
        var tstamps = Util.keysToSortedArray(revObj.allRevisions);
        var revision = tstamps.indexOf(id);

        if (revision !== -1) { // If there is such revision
            var data = {
                content: content,
                id: id,
                revision: revision,
                patchesByTS: {}
            };

            for (var t = 0, l = tstamps.length; t < l; t++) {
                data.patchesByTS[tstamps[t]] = revObj.allRevisions[tstamps[t]].patch[0];
            }
            return data;
        }
    },

    /**
     * Revisions#loadRevision(id, nextAction)
     * - id(Number): Timestamp id of the revision to load
     * - nextAction(String): Action to perform when loaded (currently either "preview" or "apply")
     *
     * Retrieves the original contents of a particular revision. It might be that
     * the original contents were cached, in which case the round trip to the
     * server is avoided. The `nextAction` parameter will eventually tell the client
     * what to do once everything is loaded.
     **/
    loadRevision: function(id, nextAction) {
        if (nextAction === "preview") {
            this.$setRevisionNodeAttribute(id, "loading_preview", "true");
        }
        else {
            this.$setRevisionNodeAttribute(id, "loading", "true");
        }

        var path = Util.getDocPath();
        var revObj = this.rawRevisions[path];
        if (revObj) {
            return this.onMessage({
                message: {
                    id: id,
                    type: "revision",
                    subtype: "getRevisionHistory",
                    path: path,
                    nextAction: nextAction
                }
            });
        }

        // We haven't cached the original content. Let's load it from the server.
        ide.send({
            command: "revisions",
            subCommand: "getRevisionHistory",
            nextAction: nextAction,
            path: path,
            id: id
        });
    },

    /**
     * Revisions#generateCompactRevisions() -> Object
     *
     * Creates a compacted revisions object from the extended revisions object
     * returned from the server. A compacted revisions object (CRO) is a revision
     * object with less detailed revisions, and it does that by grouping revisions
     * that are close in time. That lapse in time is determined by the `TIMELAPSE`
     * constant.
     *
     * Assumes that `allRevisions` is populated at this point.
     **/
    generateCompactRevisions: function(revObj) {
        var all = revObj.allRevisions;
        if (!all)
            return;

        var compactRevisions = {};
        var finalTS = [];
        var isRestoring = function(id) { return all[id] && all[id].restoring; };

        // This extracts the timestamps that belong to 'restoring' revisions to
        // put them in their own slot, since we don't want them to be grouped in
        // the compacted array. They should be independent of the compacting to
        // not confuse the user.
        var repack = function(prev, id) {
            var last = prev[prev.length - 1];
            if (last.length === 0 || (!isRestoring(id) && !isRestoring(last[0]))) {
                last.push(id);
            }
            else { prev.push([id]); }
            return prev;
        };

        var timestamps = Util.keysToSortedArray(revObj.allRevisions);
        Util.compactRevisions(timestamps).forEach(function(ts) {
            finalTS.push.apply(finalTS, ts.__reduce(repack, [[]]));
        });

        revObj.groupedRevisionIds = finalTS;

        finalTS.forEach(function(tsGroup) {
            // The property name will be the id of the last timestamp in the group.
            var id = tsGroup[tsGroup.length - 1];
            var groupObj = finalTS[id] = {
                // Store first timestamp in the group, for future nextActions
                first: tsGroup[0],
                patch: []
            };

            // We get all the properties from the revision that has the last
            // timestamp in the group
            Object.keys(all[id]).forEach(function(key) {
                if (key !== "patch") { groupObj[key] = all[id][key]; }
            });

            var contributors = [];
            tsGroup.forEach(function(ts) {
                if (all[ts]) {
                    // Add the patch to the list. In this case, and because of
                    // the Diff format nature, it will just work by concatenating
                    // strings.
                    groupObj.patch.push(all[ts].patch);

                    // Add the contributors to every revision in the group to the
                    // contributors in the head revision `contributors` array.
                    if (all[ts].contributors) {
                        all[ts].contributors.forEach(function(ct) {
                            if (contributors.indexOf(ct) === -1) {
                                contributors.push(ct);
                            }
                        });
                    }
                }
            });
            groupObj.contributors = contributors;
            compactRevisions[id] = groupObj;
        });

        revObj.compactRevisions = compactRevisions;
        return compactRevisions;
    },

    /**
     * Revisions#applyRevision(id, value)
     * - id(Number): Numeric timestamp identifier of the revision
     * - value(String): Contents of the document at the time of the revision
     *
     * Applies the revision to the current document. That will trigger the client
     * to replace the contents of the document by the ones of the state of the
     * document when that revision was saved. It adds a 'recovery' revision to
     * the list of revisions.
     **/
    applyRevision: function(id, value) {
        // Assuming that we are applying the revision to the current page. Could
        // it happen any other way?
        var doc = tabEditors.getPage().$doc;
        doc.setValue(value);

        this.$setRevisionNodeAttribute(id, "loading", "false");
        this.saveRevision(doc, true, id);
        this.hide();
    },

    /**
     * Revisions#previewRevision(id, value, ranges[, newSession])
     * - id(Number): Numeric timestamp identifier of the revision
     * - value(String): Contents of the document at the time of the revision
     * - ranges(Array): Range of differences showing what changes were introduced by this revision
     *
     * Previews changes made to the document by that particular revision. It
     * creates a new temporary Ace session and replaces the real document by this
     * read-only session.
     **/
    previewRevision: function(id, value, ranges, newSession) {
        var editor = ceEditor.$editor;
        var session = editor.getSession();
        var revObj = this.$getRevisionObject(Util.getDocPath());

        if (session.previewRevision !== true && !revObj.realSession) {
            revObj.realSession = session;
        }

        var doc;
        if (!newSession) {
            doc = new ProxyDocument(new Document(value || ""));
            newSession = new EditSession(doc, revObj.realSession.getMode());
            newSession.previewRevision = true;

            ranges.forEach(function(range) {
                Util.addCodeMarker(newSession, doc, range[4], {
                    fromRow: range[0],
                    fromCol: range[1],
                    toRow: range[2],
                    toCol: range[3]
                });
            });

            editor.setSession(newSession);
            var firstChange = 0;
            if (ranges.length > 0) {
                // Retrieve the first row of the first change in the changeset.
                firstChange = ranges[0][0];
            }
            // Scroll to the first change, leaving it in the middle of the screen.
            editor.renderer.scrollToRow(firstChange - (editor.$getVisibleRowCount() / 2));
        }
        else {
            editor.setSession(newSession);
            doc = newSession.doc;
        }

        editor.setReadOnly(true);
        editor.selection.clearSelection();

        // Look for the node that references the revision we are loading and
        // update its state to loaded.
        this.$setRevisionNodeAttribute(id, "loading_preview", "false");
        if (!revObj.previewCache) {
            revObj.previewCache = {};
        }
        if (!revObj.previewCache[id]) {
            revObj.previewCache[id] = [newSession, ranges];
        }
    },

    /**
     * Revisions#goToEditView()
     *
     * Ensures that the editor is in edit view (i.e. not read-only), and that it
     * contains the latest content.
     **/
    goToEditView: function() {
        if (typeof ceEditor === "undefined")
            return;

        var revObj = this.$getRevisionObject(Util.getDocPath());
        if (revObj.realSession) {
            ceEditor.$editor.setSession(revObj.realSession);
        }
        ceEditor.$editor.setReadOnly(false);
        ceEditor.show();
    },

    doAutoSave: function() {
        // Take advantage of the interval and dump our offlineQueue into
        // localStorage.
        localStorage.offlineQueue = JSON.stringify(this.offlineQueue);

        if (typeof tabEditors === "undefined" || !this.isAutoSaveEnabled)
            return;

        this.save(tabEditors.getPage());
    },

    /**
     * Revisions#save([page])
     * - page(Object): Page that contains the document to be saved. In case it is
     * not provided, the current one will be used
     *
     * Prompts a save of the desired document.
     **/
    save: function(page, forceSave) {
        if (!page || !page.$at)
            page = tabEditors.getPage();

        if (!page)
            return;

        if ((forceSave !== true) && (!Util.pageHasChanged(page) || !Util.pageIsCode(page)))
            return;

        var node = page.$doc.getNode();
        if (node.getAttribute("newfile") || node.getAttribute("debug"))
            return;

        Save.quicksave(page, function() {
            stripws.enable();
        }, true);
    },

    /**
     * Revisions#saveRevision(doc, silentsave, restoring) -> Void
     * - doc (Object): Document Object that refers to the document we want to save a revision for
     * - silentsave (Boolean): Indicates whether the save is automatic or forced
     * - restoring (Boolean): Indicates whether we are saving a previous revision retrieval
     *
     * Sends the necessary data for the server so it can save a revision of the
     * current document.
     **/
    saveRevision: function(doc, silentsave, restoring) {
        var page = doc.$page;
        if (!Util.pageIsCode(page)) {
            return;
        }

        var docPath = Util.getDocPath(page);
        var contributors = this.$getEditingUsers(docPath);
        if (contributors.length === 0 && this.defaultUser.email) {
            contributors.push(this.defaultUser.email);
        }

        var data = {
            path: docPath,
            silentsave: !!silentsave,
            restoring: restoring,
            contributors: contributors,
            type: "newRevision",
            lastContent: doc.getValue()
        };

        this.setSaveButtonCaption();

        if (ide.onLine === false) {
            data.ts = Date.now();
            this.offlineQueue.push(data);
        }
        else {
            if (this.isCollab() && !this.iAmMaster(docPath)) {
                // We are not master, so we want to tell the server to tell
                // master to save for us. For now, since the master is saving
                // every .5 seconds and auto-save is mandatory, we are not
                // taking care of it
                return;
            }

            // We should get here if we are in collab AND we are master, OR if
            // we are in single mode. In both situations, we just want the
            // current user to save its docs contents
            var revObj = this.$getRevisionObject(docPath);
            if (revObj.hasBeenSentToWorker === true) {
                this.worker.postMessage({
                    type: "newRevision",
                    path: docPath,
                    lastContent: data.lastContent,
                    hasBeenSentToWorker: true
                });
            }
            else {
                data.revisions = revObj.allRevisions;
                this.worker.postMessage(data);
                revObj.hasBeenSentToWorker = true;
            }
        }

        this.$resetEditingUsers(docPath);
    },

    /**
     * Revisions#addUserToDocChangeList(user, doc)
     * - user(Object): User object
     * - doc(Object): Document that has been changed
     *
     * Appends a new user to the list of people who has made changes in the
     * document since the last revision was saved.
     **/
    addUserToDocChangeList: function(user, doc) {
        if (user && doc) {
            var path = Util.getDocPath(doc.$page);
            var stack = this.rawRevisions[path];
            if (stack && (stack.usersChanged.indexOf(user.user.email) === -1)) {
                stack.usersChanged.push(user.user.email);
            }
        }
    },

    getCollab: function() {
        return require("core/ext").extLut["ext/collab/collab"];
    },

    getUser: function(suffix, doc) {
        if (doc && doc.users && doc.users[suffix]) {
            var uid = doc.users[suffix].split("-")[0];
            var collab = this.getCollab();
            if (collab && collab.users[uid]) {
                return collab.users[uid];
            }
        }
    },

    getUserColorByEmail: function(email) {
        var color;
        var collab = this.getCollab();
        if(!collab)
            return;
        var user = collab.model.queryNode("group[@name='members']/user[@email='" + email + "']");
        if (user) {
            color = user.getAttribute("color");
        }
        // This cannot possibly do anything
    },

    /**
     * Revisions#$setRevisionNodeAttribute()
     *
     * Sets an attribute on a revision apf node object in the model.
     **/
    $setRevisionNodeAttribute: function(id, attr, value) {
        var node = this.model.queryNode("revision[@id='" + id + "']");
        if (node) {
            apf.xmldb.setAttribute(node, attr, value);
        }
    },

    $getEditingUsers: function(path) {
        var users = [];
        if (this.rawRevisions[path] && this.rawRevisions[path].usersChanged) {
            users = this.rawRevisions[path].usersChanged;
        }
        return users;
    },

    $resetEditingUsers: function(path) {
        if (this.rawRevisions[path]) {
            this.rawRevisions[path].usersChanged = [];
        }
        return this.rawRevisions[path].usersChanged;
    },

    $setRevisionListClass: function() {
        var revObj = this.rawRevisions[Util.getDocPath()];
        if (!revObj) {
            return;
        }

        if (revObj.useCompactList === true) {
            apf.setStyleClass(lstRevisions.$ext, "compactView");
        }
        else {
            apf.setStyleClass(lstRevisions.$ext, null, ["compactView"]);
        }

        this.populateModel(revObj, this.model);
    },

    isNewPage: function(page) {
        return parseInt(page.$model.data.getAttribute("newfile"), 10) === 1;
    },

    show: function() {
        var page = tabEditors.getPage();
        if (!Util.pageIsCode(page)) {
            return;
        }

        ext.initExtension(this);

        settings.model.setQueryValue("general/@revisionsvisible", true);

        if (!this.panel.visible) {
            ceEditor.$ext.style.right = BAR_WIDTH + "px";
            page.$showRevisions = true;
            this.panel.show();
            ide.dispatchEvent("revisions.visibility", {
                visibility: "shown",
                width: BAR_WIDTH
            });

            beautify.disable();
            statusbar.offsetWidth = BAR_WIDTH;
            statusbar.setPosition();
            stripws.disable();
            language.disable();
        }

        var model = page.$mdlRevisions;
        if (lstRevisions && model && (lstRevisions.getModel() !== model)) {
            lstRevisions.setModel(model);
        }

        if (model) {
            if (!model.data || model.data.childNodes.length === 0) {
                this.populateModel(this.rawRevisions[Util.getDocPath()], model);
            }
            else {
                this.$restoreSelection(page, model);
            }
        }
    },

    hide: function() {
        settings.model.setQueryValue("general/@revisionsvisible", false);
        ceEditor.$ext.style.right = "0";
        var page = tabEditors.getPage();
        if (!page) return;

        page.$showRevisions = false;
        this.panel.hide();
        ide.dispatchEvent("revisions.visibility", { visibility: "hidden" });

        beautify.enable();
        statusbar.offsetWidth = 0;
        statusbar.setPosition();
        stripws.enable();
        language.enable();

        if (lstRevisions) {
            lstRevisions.selectList([]); // Unselect everything
        }

        this.goToEditView();
    },

    disableEventListeners: function() {
        if (this.$onMessageFn)
            ide.removeEventListener("socketMessage", this.$onMessageFn);

        if (this.$onOpenFileFn)
            ide.removeEventListener("afteropenfile", this.$onOpenFileFn);

        if (this.$onCloseFileFn)
            ide.removeEventListener("closefile", this.$onCloseFileFn);

        if (this.$onFileSaveFn)
            ide.removeEventListener("afterfilesave", this.$onFileSaveFn);

        if (this.$onSwitchFileFn)
            ide.removeEventListener("tab.beforeswitch", this.$onSwitchFileFn);

        if (this.$onAfterSwitchFn)
            ide.removeEventListener("tab.afterswitch", this.$onAfterSwitchFn);

        if (this.$afterSelectFn)
            lstRevisions.removeEventListener("afterselect", this.$afterSelectFn);

        if (this.$onAfterOnline)
            ide.removeEventListener("onafteronline", this.$onAfterOnline);

        if (this.$onRevisionSaved)
            ide.removeEventListener("revisionSaved", this.$onRevisionSaved);

        if (this.$onExternalChange)
            ide.removeEventListener("beforewatcherchange", this.$onExternalChange);

        if (this.$onBeforeSaveWarning)
            ide.removeEventListener("beforesavewarn", this.$onBeforeSaveWarning);
    },

    enableEventListeners: function() {
        if (this.$onMessageFn)
            ide.addEventListener("socketMessage", this.$onMessageFn);

        if (this.$onOpenFileFn)
            ide.addEventListener("afteropenfile", this.$onOpenFileFn);

        if (this.$onCloseFileFn)
            ide.addEventListener("closefile", this.$onCloseFileFn);

        if (this.$onFileSaveFn)
            ide.addEventListener("afterfilesave", this.$onFileSaveFn);

        if (this.$onSwitchFileFn)
            ide.addEventListener("tab.beforeswitch", this.$onSwitchFileFn);

        if (this.$onAfterSwitchFn)
            ide.addEventListener("tab.afterswitch", this.$onAfterSwitchFn);

        if (this.$afterSelectFn)
            lstRevisions.addEventListener("afterselect", this.$afterSelectFn);

        if (this.$onAfterOnline)
            ide.addEventListener("onafteronline", this.$onAfterOnline);

        if (this.$onRevisionSaved)
            ide.addEventListener("revisionSaved", this.$onRevisionSaved);

        if (this.$onExternalChange)
            ide.addEventListener("beforewatcherchange", this.$onExternalChange);

        if (this.$onBeforeSaveWarning)
            ide.addEventListener("beforesavewarn", this.$onBeforeSaveWarning);
    },

    enable: function() {
        this.nodes.each(function(item) {
            item.enable();
        });

        tabEditors.getPages().forEach(function(page) {
            var listener = this.docChangeListeners[page.name];
            if (listener) {
                page.$doc.removeEventListener("change", listener);
                if (page.$doc.acedoc) {
                    page.$doc.acedoc.removeEventListener("change", listener);
                }

                (page.$doc.acedoc || page.$doc).addEventListener("change", listener);
            }
        }, this);

        this.enableEventListeners();
    },

    disable: function() {
        this.hide();
        this.nodes.each(function(item){
            item.disable();
        });

        tabEditors.getPages().forEach(function(page) {
            var listener = this.docChangeListeners[page.name];
            if (listener) {
                page.$doc.removeEventListener("change", listener);
                if (page.$doc.acedoc) {
                    page.$doc.acedoc.removeEventListener("change", listener);
                }
            }
            if (page.$mdlRevisions) {
                delete page.$mdlRevisions;
            }
        }, this);

        this.disableEventListeners();
    },

    destroy: function() {
        menus.remove("File/File revisions");
        menus.remove("File/~", 1000);

        commands.removeCommandByName("revisionpanel");

        if (this.saveInterval) {
            clearInterval(this.saveInterval);
        }

        this.disableEventListeners();

        tabEditors.getPages().forEach(function(page) {
            var listener = this.docChangeListeners[page.name];
            if (listener) {
                page.$doc.removeEventListener("change", listener);
                if (page.$doc.acedoc) {
                    page.$doc.acedoc.removeEventListener("change", listener);
                }
            }
            if (page.$mdlRevisions) {
                delete page.$mdlRevisions;
            }
        }, this);

        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }

        this.nodes.each(function(item){
            item.destroy(true, true);
        });
        this.nodes = [];
    }
});
});
