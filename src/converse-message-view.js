// Converse.js
// https://conversejs.org
//
// Copyright (c) 2013-2019, the Converse.js developers
// Licensed under the Mozilla Public License (MPLv2)
/**
 * @module converse-message-view
 */
import URI from "urijs";
import converse from  "@converse/headless/converse-core";
import { debounce } from 'lodash'
import filesize from "filesize";
import html from "./utils/html";
import tpl_csn from "templates/csn.html";
import tpl_file_progress from "templates/file_progress.html";
import tpl_info from "templates/info.html";
import tpl_message from "templates/message.html";
import tpl_message_versions_modal from "templates/message_versions_modal.html";
import tpl_spinner from "templates/spinner.html";
import u from "@converse/headless/utils/emoji";
import xss from "xss/dist/xss";

const { Backbone, dayjs } = converse.env;


converse.plugins.add('converse-message-view', {

    dependencies: ["converse-modal", "converse-chatboxviews"],

    initialize () {
        /* The initialize function gets called as soon as the plugin is
         * loaded by converse.js's plugin machinery.
         */
        const { _converse } = this;
        const { __ } = _converse;


        function onTagFoundDuringXSSFilter (tag, html, options) {
            /* This function gets called by the XSS library whenever it finds
             * what it thinks is a new HTML tag.
             *
             * It thinks that something like <https://example.com> is an HTML
             * tag and then escapes the <> chars.
             *
             * We want to avoid this, because it prevents these URLs from being
             * shown properly (whithout the trailing &gt;).
             *
             * The URI lib correctly trims a trailing >, but not a trailing &gt;
             */
            if (options.isClosing) {
                // Closing tags don't match our use-case
                return;
            }
            const uri = new URI(tag);
            const protocol = uri.protocol().toLowerCase();
            if (!["https", "http", "xmpp", "ftp"].includes(protocol)) {
                // Not a URL, the tag will get filtered as usual
                return;
            }
            if (uri.equals(tag) && `<${tag}>` === html.toLocaleLowerCase()) {
                // We have something like <https://example.com>, and don't want
                // to filter it.
                return html;
            }
        }


        _converse.api.settings.update({
            'show_images_inline': true
        });

        _converse.MessageVersionsModal = _converse.BootstrapModal.extend({
            toHTML () {
                return tpl_message_versions_modal(Object.assign(
                    this.model.toJSON(), {
                    '__': __,
                    'dayjs': dayjs
                }));
            }
        });


        /**
         * @class
         * @namespace _converse.MessageView
         * @memberOf _converse
         */
        _converse.MessageView = _converse.ViewWithAvatar.extend({

            savedReactions: [],

            events: {
                'click .chat-msg__edit-modal': 'showMessageVersionsModal',
                'click .retry': 'onRetryClicked'
            },

            initialize () {
                this.debouncedRender = debounce(() => {
                    // If the model gets destroyed in the meantime,
                    // it no longer has a collection
                    if (this.model.collection) {
                        this.render();
                    }
                }, 50);

                setInterval(() => {
                    if(this.savedReactions.length > 0)
                    {
                        var savedLength = this.savedReactions.length;
                        var currentThis = this.model;
                        for(var i = 0; i < this.savedReactions.length ; i++){
                            this.model = this.savedReactions[i];
                                this.renderReaction();
                        }
                        this.model = currentThis;
                    }
                }, 2000);

                if (this.model.vcard) {
                    this.model.vcard.on('change', this.debouncedRender, this);
                }

                if (this.model.rosterContactAdded) {
                    this.model.rosterContactAdded.then(() => {
                        this.model.contact.on('change:nickname', this.debouncedRender, this);
                        this.debouncedRender();
                    });
                }

                if (this.model.occupant) {
                    this.model.occupant.on('change:role', this.debouncedRender, this);
                    this.model.occupant.on('change:affiliation', this.debouncedRender, this);
                    this.debouncedRender();
                }

                this.model.on('change', this.onChanged, this);
                this.model.on('destroy', this.fadeOut, this);
            },

            async render () {
                const is_followup = u.hasClass('chat-msg--followup', this.el);
                if (this.model.isOnlyChatStateNotification()) {
                    this.renderChatStateNotification()
                } else if (this.model.get('file') && !this.model.get('oob_url')) {
                    if (!this.model.file) {
                        _converse.log("Attempted to render a file upload message with no file data");
                        return this.el;
                    }
                    this.renderFileUploadProgresBar();
                } else if (this.model.get('type') === 'error') {
                    this.renderErrorMessage();
                } else if (this.model.get('type') === 'info') {
                    this.renderInfoMessage();
                } else {
                    await this.renderChatMessage();
                }
                if (is_followup) {
                    u.addClass('chat-msg--followup', this.el);
                }

                return this.el;
            },

            async onChanged (item) {
                // Jot down whether it was edited because the `changed`
                // attr gets removed when this.render() gets called further
                // down.
                const edited = item.changed.edited;
                if (this.model.changed.progress) {
                    return this.renderFileUploadProgresBar();
                }
                const isValidChange = prop => Object.prototype.hasOwnProperty.call(this.model.changed, prop);
                if (['correcting', 'message', 'type', 'upload', 'received'].filter(isValidChange).length) {
                    await this.debouncedRender();
                }
                if (edited) {
                    this.onMessageEdited();
                }
            },

            fadeOut () {
                if (_converse.animate) {
                    setTimeout(() => this.remove(), 600);
                    u.addClass('fade-out', this.el);
                } else {
                    this.remove();
                }
            },

            async onRetryClicked () {
                this.showSpinner();
                await this.model.error.retry();
                this.model.destroy();
            },

            showSpinner () {
                this.el.innerHTML = tpl_spinner();
            },

            onMessageEdited () {
                if (this.model.get('is_archived')) {
                    return;
                }
                this.el.addEventListener(
                    'animationend',
                    () => u.removeClass('onload', this.el),
                    {'once': true}
                );
                
                    
                u.addClass('onload', this.el);
            },

            replaceElement (msg) {
                if (this.el.parentElement) {
                    this.el.parentElement.replaceChild(msg, this.el);
                }
                this.setElement(msg);
                return this.el;
            },

            transformOOBURL (url) {
                url = u.renderFileURL(_converse, url);
                url = u.renderMovieURL(_converse, url);
                url = u.renderAudioURL(_converse, url);
                return u.renderImageURL(_converse, url);
            },

            async transformBodyText (text) {
                /**
                 * Synchronous event which provides a hook for transforming a chat message's body text
                 * before the default transformations have been applied.
                 * @event _converse#beforeMessageBodyTransformed
                 * @param { _converse.MessageView } view - The view representing the message
                 * @param { string } text - The message text
                 * @example _converse.api.listen.on('beforeMessageBodyTransformed', (view, text) => { ... });
                 */
                await _converse.api.trigger('beforeMessageBodyTransformed', this, text, {'Synchronous': true});
                text = this.model.isMeCommand() ? text.substring(4) : text;
                text = xss.filterXSS(text, {'whiteList': {}, 'onTag': onTagFoundDuringXSSFilter});
                text = u.geoUriToHttp(text, _converse.geouri_replacement);
                text = u.addMentionsMarkup(text, this.model.get('references'), this.model.collection.chatbox);
                text = u.addHyperlinks(text);
                text = u.renderNewLines(text);
                text = u.addEmoji(_converse, text);
                /**
                 * Synchronous event which provides a hook for transforming a chat message's body text
                 * after the default transformations have been applied.
                 * @event _converse#afterMessageBodyTransformed
                 * @param { _converse.MessageView } view - The view representing the message
                 * @param { string } text - The message text
                 * @example _converse.api.listen.on('afterMessageBodyTransformed', (view, text) => { ... });
                 */
                await _converse.api.trigger('afterMessageBodyTransformed', this, text, {'Synchronous': true});
                return text;
            },

            async renderChatMessage () {
                const is_me_message = this.model.isMeCommand();
                const time = dayjs(this.model.get('time'));
                const role = this.model.vcard ? this.model.vcard.get('role') : null;
                const roles = role ? role.split(',') : [];
                if(this.model.get('reactsTo')){
                    this.renderReaction();
                    return;
                 }
                const msg = u.stringToElement(tpl_message(
                    Object.assign(
                        this.model.toJSON(), {
                        '__': __,
                        'is_groupchat_message': this.model.get('type') === 'groupchat',
                        'occupant': this.model.occupant,
                        'is_me_message': is_me_message,
                        'roles': roles,
                        'pretty_time': time.format(_converse.time_format),
                        'time': time.toISOString(),
                        'extra_classes': this.getExtraMessageClasses(),
                        'label_show': __('Show more'),
                        'username': this.model.getDisplayName()
                    })
                ));
                const url = this.model.get('oob_url');
                if (url) {
                    msg.querySelector('.chat-msg__media').innerHTML = this.transformOOBURL(url);
                }

                const text = this.model.getMessageText();
                const msg_content = msg.querySelector('.chat-msg__text');
                if (text && text !== url) {
                    msg_content.innerHTML = await this.transformBodyText(text);
                    await u.renderImageURLs(_converse, msg_content);
                }
                if(msg.querySelectorAll('.chat-msg__edit-modal').length > 0){
                    var savedId = this.model.get('msgid');
                    for(var i = 0; i < this.savedReactions.length ; i++){
                        if(this.savedReactions[i].get('reactsTo')==savedId){
                            this.savedReactions[i].save({
                                'rendered': false
                            });
                        }
                    }
                }
                const promise = u.renderImageURLs(_converse, msg_content);
                if (this.model.get('type') !== 'headline') {
                    this.renderAvatar(msg);
                }
                this.replaceElement(msg);
                if (this.model.collection) {
                    // If the model gets destroyed in the meantime, it no
                    // longer has a collection.
                    this.model.collection.trigger('rendered', this);
                }
                 
            },

            renderInfoMessage () {
                const msg = u.stringToElement(
                    tpl_info(Object.assign(this.model.toJSON(), {
                        'extra_classes': 'chat-info',
                        'isodate': dayjs(this.model.get('time')).toISOString()
                    }))
                );
                return this.replaceElement(msg);
            },

            renderErrorMessage () {
                const msg = u.stringToElement(
                    tpl_info(Object.assign(this.model.toJSON(), {
                        'extra_classes': 'chat-error',
                        'isodate': dayjs(this.model.get('time')).toISOString()
                    }))
                );
                return this.replaceElement(msg);
            },

            renderChatStateNotification () {
                let text;
                const from = this.model.get('from'),
                      name = this.model.getDisplayName();

                if (this.model.get('chat_state') === _converse.COMPOSING) {
                    if (this.model.get('sender') === 'me') {
                        text = __('Typing from another device');
                    } else {
                        text = __('%1$s is typing', name);
                    }
                } else if (this.model.get('chat_state') === _converse.PAUSED) {
                    if (this.model.get('sender') === 'me') {
                        text = __('Stopped typing on the other device');
                    } else {
                        text = __('%1$s has stopped typing', name);
                    }
                } else if (this.model.get('chat_state') === _converse.GONE) {
                    text = __('%1$s has gone away', name);
                } else {
                    return;
                }
                const isodate = (new Date()).toISOString();
                this.replaceElement(
                      u.stringToElement(
                        tpl_csn({
                            'message': text,
                            'from': from,
                            'isodate': isodate
                        })));
            },

            renderReaction(msg){
                var message = document.querySelectorAll(`[data-msgid="${this.model.get('reactsTo')}"`)? 
                            document.querySelectorAll(`[data-msgid="${this.model.get('reactsTo')}"`): null ;

                //workaround issue of showing reaction as message
                if(document.querySelectorAll(`[data-msgid="${this.model.get('msgid')}"`).length > 0){
                    for(var i = 0; i < document.querySelectorAll(`[data-msgid="${this.model.get('msgid')}"`).length; i++){
                        document.querySelectorAll(`[data-msgid="${this.model.get('msgid')}"`)[i].parentNode.removeChild(document.querySelectorAll(`[data-msgid="${this.model.get('msgid')}"`)[i]);
                    }
                }
                /*
                1ST CASE : 
                    div for message is created independently from document
                    the div is to be added later into the document
                */
                if(msg != undefined && msg != null){  
                    var body = msg.querySelectorAll('.chat-msg_content');
                    var callQuits = false;
                    //removing other reactions by same user
                    if(body != null && body != undefined && body.length > 0){
                        var allReacts = body[0].querySelectorAll('.react');
                        for(var i=0; i < allReacts.length; i++){
                            var userReacts = allReacts[i].getElementsByTagName('span')[0];
                            if(userReacts.getAttribute('data-reactusers').includes(this.model.get('from'))){
                                userReacts.setAttribute('data-reactusers', userReacts.getAttribute('data-reactusers').replace(this.model.get('from'), ''));
                                if(userReacts.innerHTML == 1){
                                    allReacts[i].parentNode.removeChild(allReacts[i]);
                                }
                                else{
                                    userReacts.innerHTML = parseInt(userReacts.innerHTML) - 1;
                                }
                                if(allReacts[i].id == this.model.get('message')){
                                    callQuits = true;
                                }
                                this.savedReactions[this.savedReactions.indexOf(this.model)].save({
                                    'removed': true
                                });
                            }
                        }

                        if(callQuits){
                            this.savedReactions[this.savedReactions.indexOf(this.model)].save({
                                'rendered': true
                            });
                            return;
                        }

                        //adding reaction 
                        var prevReact =  body[0].querySelectorAll('#'+this.model.get('message'));
                        if(prevReact === null || prevReact == undefined || prevReact.length == 0)
                        {
                            var reaction = document.createElement('div');
                            reaction.id = this.model.get('message');
                            reaction.className = "react";
                            if(reaction.getAttribute('data-reactionid') === null || reaction.getAttribute('data-reactionid') == undefined){
                                reaction.setAttribute('data-reactionid', this.model.get('msgid'));
                            }
                            else{
                                reaction.setAttribute('data-reactionid', reaction.getAttribute('data-reactionid')+' '+this.model.get('msgid'));
                            }
                            reaction.innerHTML = this.model.get('message') +" +";
                            var counter = document.createElement('span');
                            counter.classList.add(this.model.get('msgid'));
                            counter.setAttribute('data-reactusers', this.model.get('from'));                                    
                            counter.innerHTML = '1';
                            reaction.appendChild(counter);
                            var refNode = body[0].getElementsByClassName("chat-msg__message")[0];
                            // body[0].insertBefore(reaction, refNode.nextSibling);
                            body[0].querySelectorAll('.chat-msg__reacts')[0].appendChild(reaction);
                            this.savedReactions[this.savedReactions.indexOf(this.model)].save({
                                'rendered': true
                            });
                            return;
                        } 
                        
                        else {
                            var counter = prevReact[0].getElementsByTagName('span')[0];
                            if(counter.getAttribute('data-reactusers').includes(this.model.get('from'))){
                                //decrease &erase reaction, erase from savedReactions
                                if(parseInt(counter.innerHTML) == 1){
                                    prevReact[0].parentNode.removeChild(prevReact[0]);
                                }
                                else{
                                    counter.innerHTML = parseInt(counter.innerHTML)-1;                                    
                                }
                                counter.setAttribute('data-reactusers', counter.getAttribute('data-reactusers').replace(this.model.get('from'), ''));
                                var indexMsg = this.savedReactions.indexOf(this.model);
                                this.savedReactions[indexMsg].save({
                                    'removed': true
                                });
                                return;
                            }
                            if(counter.classList.contains(this.model.get('msgid'))){
                                return; //reaction already rendered
                            }
                            counter.classList.add(this.model.get('msgid'));
                            if(counter.getAttribute('data-reactusers') === null || counter.getAttribute('data-reactusers') == undefined){
                                counter.setAttribute('data-reactusers', this.model.get('from'));
                            }
                            else{
                                counter.setAttribute('data-reactusers', counter.getAttribute('data-reactusers')+' '+this.model.get('from'));
                            }
                            counter.innerHTML = parseInt(counter.innerHTML)+1;
                            this.savedReactions[this.savedReactions.indexOf(this.model)].save({
                                'rendered': true
                            });
                        }
                        return;               
                    }
                    return;
                }

                /*
                2ND CASE : 
                    div for message is added directly to document
                */

                if(document.querySelectorAll(`[data-reactionid="${this.model.get('msgid')}"`)!= null 
                    && document.querySelectorAll(`[data-reactionid="${this.model.get('msgid')}"`)!= undefined
                     && document.querySelectorAll(`[data-reactionid="${this.model.get('msgid')}"`).length > 0){
                    return; //reaction aleady rendered : avoiding duplicates
                }

                var existingIndex = undefined;
                for(var i = 0; i < this.savedReactions.length; i++){
                    if(this.savedReactions[i].get('msgid')==this.model.get('msgid')){
                        existingIndex = i;
                        break;
                    }
                }
                if(existingIndex == undefined){
                    var toSave = this.model;
                    toSave.save({
                        'removed': false,
                        'rendered': false
                    });
                    this.savedReactions.push(toSave);
                    existingIndex = this.savedReactions.indexOf(toSave);
                }

                if(message != null && message != undefined && message.length > 0){
                    if(existingIndex != undefined && existingIndex != -1 &&
                    (this.savedReactions[existingIndex].get('rendered')
                    || this.savedReactions[existingIndex].get('removed'))){
                        return;
                    }
                    var body = message[0].querySelectorAll('.chat-msg__content');
                    if(body != null && body != undefined && body.length > 0){
                        var prevReact =  body[0].querySelectorAll('#'+this.model.get('message'));
                        if(prevReact === null || prevReact == undefined || prevReact.length == 0)
                        {
                            //check if there was a prior reaction
                            var allReacts = body[0].querySelectorAll('.react');
                            for(var i=0; i < allReacts.length; i++){
                                var savedData = {
                                    'reaction': allReacts[i].id,
                                    'from': this.model.get('from'),
                                    'to': this.model.get('jid'),
                                    'msg': this.model.get('reactsTo')
                                };
                                var userReacts = allReacts[i].getElementsByTagName('span')[0];
                                if(userReacts.getAttribute('data-reactusers').includes(this.model.get('from'))){
                                    userReacts.setAttribute('data-reactusers', userReacts.getAttribute('data-reactusers').replace(this.model.get('from'), ''));
                                    if(userReacts.innerHTML == 1){
                                        allReacts[i].parentNode.removeChild(allReacts[i]);
                                    }
                                    else{
                                        userReacts.innerHTML = parseInt(userReacts.innerHTML) - 1;
                                    }
                                    for(var i = 0; i < this.savedReactions.length; i++){
                                        if(this.savedReactions[i].get('from')==savedData.from 
                                        && this.savedReactions[i].get('message')==savedData.message
                                        && this.savedReactions[i].get('jid')==savedData.to
                                        && this.savedReactions[i].get('reactsTo')==savedData.reactsTo){
                                            this.savedReactions[i].save({
                                                'removed': true
                                            });
                                        }
                                    }
                                }
                            }
                            var reaction = document.createElement('div');
                            reaction.id = this.model.get('message');
                            reaction.className = "react";
                            reaction.setAttribute('data-reactionid', this.model.get('msgid'));
                            reaction.innerHTML = this.model.get('message') +" +";
                            var counter = document.createElement('span');
                            counter.classList.add(this.model.get('msgid'));
                            counter.setAttribute('data-reactusers', this.model.get('from'));                                    
                            counter.innerHTML = '1';
                            reaction.appendChild(counter);
                            var refNode = body[0].getElementsByClassName("chat-msg__message")[0];
                            body[0].querySelectorAll('.chat-msg__reacts')[0].appendChild(reaction);
                            this.savedReactions[this.savedReactions.indexOf(this.model)].save({
                                'rendered': true
                            });
                        } else {
                            //check if there was a prior reaction
                            var callQuits = false;
                            var allReacts = body[0].querySelectorAll('.react');
                            for(var i=0; i < allReacts.length; i++){
                                var savedData = {
                                    'reaction': allReacts[i].id,
                                    'from': this.model.get('from'),
                                    'to': this.model.get('jid'),
                                    'msg': this.model.get('reactsTo')
                                };
                                var userReacts = allReacts[i].getElementsByTagName('span')[0];
                                if(userReacts.getAttribute('data-reactusers').includes(this.model.get('from'))){
                                    if(allReacts[i].id == this.model.get('message'))
                                    {
                                        this.savedReactions[this.savedReactions.indexOf(this.model)].save({
                                            'removed': true
                                        });
                                        callQuits = true;
                                    }
                                    userReacts.setAttribute('data-reactusers', userReacts.getAttribute('data-reactusers').replace(this.model.get('from'), ''));
                                    if(userReacts.innerHTML == 1){
                                        allReacts[i].parentNode.removeChild(allReacts[i]);
                                    }
                                    else{
                                        userReacts.innerHTML = parseInt(userReacts.innerHTML) - 1;
                                    }
                                    for(var i = 0; i < this.savedReactions.length; i++){
                                        if(this.savedReactions[i].get('from')==savedData.from 
                                        && this.savedReactions[i].get('message')==savedData.message
                                        && this.savedReactions[i].get('jid')==savedData.to
                                        && this.savedReactions[i].get('reactsTo')==savedData.reactsTo){
                                            this.savedReactions[i].save({
                                                'removed': true
                                            });
                                        }

                                    }
                                }
                            }
                            if(callQuits){
                                this.savedReactions[this.savedReactions.indexOf(this.model)].save({
                                    'removed': true
                                });
                                return;
                            }
                            var counter = prevReact[0].getElementsByTagName('span')[0];
                            if(counter.classList.contains(this.model.get('msgid'))){
                                return; //reaction already rendered
                            }
                            counter.classList.add(this.model.get('msgid'));
                            if(counter.getAttribute('data-reactusers') === null || counter.getAttribute('data-reactusers') == undefined){
                                counter.setAttribute('data-reactusers', this.model.get('from'));
                            }
                            else{
                                counter.setAttribute('data-reactusers', counter.getAttribute('data-reactusers')+' '+this.model.get('from'));
                            }
                            counter.innerHTML = parseInt(counter.innerHTML)+1;
                            this.savedReactions[this.savedReactions.indexOf(this.model)].save({
                                'rendered': true
                            });
                        }
                    }
                }else{
                    return; //message to which the reaction is destined doesn't exist on document
                }
            },

            renderFileUploadProgresBar () {
                const msg = u.stringToElement(tpl_file_progress(
                    Object.assign(this.model.toJSON(), {
                        '__': __,
                        'filename': this.model.file.name,
                        'filesize': filesize(this.model.file.size)
                    })));
                this.replaceElement(msg);
                this.renderAvatar();
            },

            showMessageVersionsModal (ev) {
                ev.preventDefault();
                if (this.model.message_versions_modal === undefined) {
                    this.model.message_versions_modal = new _converse.MessageVersionsModal({'model': this.model});
                }
                this.model.message_versions_modal.show(ev);
            },

            getExtraMessageClasses () {
                let extra_classes = this.model.get('is_delayed') && 'delayed' || '';

                if (this.model.get('type') === 'groupchat') {
                    if (this.model.occupant) {
                        extra_classes += ` ${this.model.occupant.get('role') || ''} ${this.model.occupant.get('affiliation') || ''}`;
                    }
                    if (this.model.get('sender') === 'them' && this.model.collection.chatbox.isUserMentioned(this.model)) {
                        // Add special class to mark groupchat messages
                        // in which we are mentioned.
                        extra_classes += ' mentioned';
                    }
                }
                if (this.model.get('correcting')) {
                    extra_classes += ' correcting';
                }
                return extra_classes;
            }
        });
    }
});
