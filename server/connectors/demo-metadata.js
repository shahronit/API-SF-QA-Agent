'use strict';
/**
 * Demo org metadata. This is SAMPLE metadata for the built-in simulator only —
 * it is never presented as a verified fact about a real org (label: ASSUMED).
 */

function f(name, label, type, o = {}) {
  const createable = o.createable !== undefined ? o.createable : !['id', 'calculated'].includes(type) && !o.system;
  const nillable = o.required ? false : o.nillable !== undefined ? o.nillable : true;
  return {
    name, label, type: type === 'calculated' ? (o.returns || 'string') : type,
    length: o.length || (type === 'string' ? 255 : type === 'email' ? 80 : type === 'phone' ? 40 : type === 'textarea' ? 32000 : type === 'url' ? 255 : type === 'id' || type === 'reference' ? 18 : 0),
    precision: o.precision || 0, scale: o.scale || 0,
    nillable, createable, updateable: o.updateable !== undefined ? o.updateable : createable && !o.createOnly,
    defaultedOnCreate: Boolean(o.defaulted), unique: Boolean(o.unique), externalId: Boolean(o.externalId),
    calculated: type === 'calculated', custom: name.endsWith('__c'),
    required: Boolean(o.required),
    referenceTo: o.ref ? [o.ref] : [], relationshipName: o.rel || null,
    picklistValues: o.values || [], restrictedPicklist: Boolean(o.restricted),
    pii: Boolean(o.pii),
  };
}

const sys = (prefix) => [
  f('Id', 'Record ID', 'id', { createable: false, updateable: false, nillable: false, system: true }),
  f('OwnerId', 'Owner ID', 'reference', { ref: 'User', rel: 'Owner', defaulted: true, nillable: false }),
  f('CreatedDate', 'Created Date', 'datetime', { system: true, createable: false, updateable: false }),
  f('LastModifiedDate', 'Last Modified Date', 'datetime', { system: true, createable: false, updateable: false }),
  f('IsDeleted', 'Deleted', 'boolean', { system: true, createable: false, updateable: false }),
];

const OBJECTS = {
  Account: {
    label: 'Account', keyPrefix: '001', custom: false,
    fields: [
      ...sys(),
      f('Name', 'Account Name', 'string', { required: true, length: 255 }),
      f('AccountNumber', 'Account Number', 'string', { length: 40 }),
      f('Type', 'Account Type', 'picklist', { values: ['Prospect', 'Customer - Direct', 'Customer - Channel', 'Channel Partner / Reseller', 'Installation Partner', 'Technology Partner', 'Other'] }),
      f('Industry', 'Industry', 'picklist', { values: ['Banking', 'Communications', 'Energy', 'Healthcare', 'Manufacturing', 'Retail', 'Technology'] }),
      f('Rating', 'Account Rating', 'picklist', { values: ['Hot', 'Warm', 'Cold'] }),
      f('Phone', 'Account Phone', 'phone', { pii: true }),
      f('Website', 'Website', 'url'),
      f('AnnualRevenue', 'Annual Revenue', 'currency', { precision: 18, scale: 0 }),
      f('NumberOfEmployees', 'Employees', 'int', { precision: 8 }),
      f('BillingCity', 'Billing City', 'string', { length: 40 }),
      f('BillingCountry', 'Billing Country', 'string', { length: 80 }),
      f('External_Id__c', 'External ID', 'string', { length: 50, unique: true, externalId: true }),
      f('Customer_Status__c', 'Customer Status', 'picklist', { values: ['Active', 'Inactive', 'On Hold'], restricted: true }),
    ],
    children: [{ childSObject: 'Contact', field: 'AccountId', relationshipName: 'Contacts' }, { childSObject: 'Opportunity', field: 'AccountId', relationshipName: 'Opportunities' }, { childSObject: 'Case', field: 'AccountId', relationshipName: 'Cases' }, { childSObject: 'Invoice__c', field: 'Account__c', relationshipName: 'Invoices__r' }],
  },
  Contact: {
    label: 'Contact', keyPrefix: '003', custom: false,
    fields: [
      ...sys(),
      f('FirstName', 'First Name', 'string', { length: 40, pii: true }),
      f('LastName', 'Last Name', 'string', { required: true, length: 80, pii: true }),
      f('Name', 'Full Name', 'string', { createable: false, updateable: false, length: 121 }),
      f('Email', 'Email', 'email', { pii: true }),
      f('Phone', 'Business Phone', 'phone', { pii: true }),
      f('MobilePhone', 'Mobile Phone', 'phone', { pii: true }),
      f('Title', 'Title', 'string', { length: 128 }),
      f('Birthdate', 'Birthdate', 'date', { pii: true }),
      f('AccountId', 'Account ID', 'reference', { ref: 'Account', rel: 'Account' }),
      f('LeadSource', 'Lead Source', 'picklist', { values: ['Web', 'Phone Inquiry', 'Partner Referral', 'Purchased List', 'Other'] }),
      f('MailingCity', 'Mailing City', 'string', { length: 40 }),
      f('MailingCountry', 'Mailing Country', 'string', { length: 80 }),
      f('External_Id__c', 'External ID', 'string', { length: 50, unique: true, externalId: true }),
      f('Preferred_Channel__c', 'Preferred Channel', 'picklist', { values: ['Email', 'Phone', 'SMS'], restricted: true }),
    ],
    children: [{ childSObject: 'Case', field: 'ContactId', relationshipName: 'Cases' }],
  },
  Opportunity: {
    label: 'Opportunity', keyPrefix: '006', custom: false,
    fields: [
      ...sys(),
      f('Name', 'Name', 'string', { required: true, length: 120 }),
      f('AccountId', 'Account ID', 'reference', { ref: 'Account', rel: 'Account' }),
      f('StageName', 'Stage', 'picklist', { required: true, values: ['Prospecting', 'Qualification', 'Needs Analysis', 'Proposal/Price Quote', 'Negotiation/Review', 'Closed Won', 'Closed Lost'], restricted: true }),
      f('CloseDate', 'Close Date', 'date', { required: true }),
      f('Amount', 'Amount', 'currency', { precision: 18, scale: 2 }),
      f('Probability', 'Probability (%)', 'percent', { precision: 3 }),
      f('Type', 'Opportunity Type', 'picklist', { values: ['Existing Customer - Upgrade', 'Existing Customer - Replacement', 'New Customer'] }),
    ],
    children: [],
  },
  Case: {
    label: 'Case', keyPrefix: '500', custom: false,
    fields: [
      ...sys(),
      f('CaseNumber', 'Case Number', 'string', { createable: false, updateable: false, length: 30 }),
      f('Subject', 'Subject', 'string', { length: 255 }),
      f('Description', 'Description', 'textarea'),
      f('Status', 'Status', 'picklist', { values: ['New', 'Working', 'Escalated', 'Closed'], defaulted: true, nillable: false, restricted: true }),
      f('Priority', 'Priority', 'picklist', { values: ['High', 'Medium', 'Low'] }),
      f('Origin', 'Case Origin', 'picklist', { values: ['Phone', 'Email', 'Web', 'Portal'] }),
      f('AccountId', 'Account ID', 'reference', { ref: 'Account', rel: 'Account' }),
      f('ContactId', 'Contact ID', 'reference', { ref: 'Contact', rel: 'Contact' }),
    ],
    children: [],
  },
  Lead: {
    label: 'Lead', keyPrefix: '00Q', custom: false,
    fields: [
      ...sys(),
      f('FirstName', 'First Name', 'string', { length: 40, pii: true }),
      f('LastName', 'Last Name', 'string', { required: true, length: 80, pii: true }),
      f('Company', 'Company', 'string', { required: true, length: 255 }),
      f('Email', 'Email', 'email', { pii: true }),
      f('Phone', 'Phone', 'phone', { pii: true }),
      f('Status', 'Lead Status', 'picklist', { values: ['Open - Not Contacted', 'Working - Contacted', 'Closed - Converted', 'Closed - Not Converted'], defaulted: true, nillable: false }),
      f('LeadSource', 'Lead Source', 'picklist', { values: ['Web', 'Phone Inquiry', 'Partner Referral', 'Purchased List', 'Other'] }),
      f('Rating', 'Rating', 'picklist', { values: ['Hot', 'Warm', 'Cold'] }),
    ],
    children: [],
  },
  Invoice__c: {
    label: 'Invoice', keyPrefix: 'a0B', custom: true,
    fields: [
      ...sys(),
      f('Name', 'Invoice Number', 'string', { required: true, length: 80 }),
      f('Account__c', 'Account', 'reference', { ref: 'Account', rel: 'Account__r', required: true }),
      f('Amount__c', 'Amount', 'currency', { precision: 16, scale: 2 }),
      f('Currency__c', 'Currency', 'picklist', { values: ['USD', 'EUR', 'GBP', 'INR'], restricted: true }),
      f('Status__c', 'Status', 'picklist', { values: ['Draft', 'Issued', 'Paid', 'Cancelled'], restricted: true }),
      f('ERP_Invoice_Id__c', 'ERP Invoice ID', 'string', { length: 40, unique: true, externalId: true }),
      f('Due_Date__c', 'Due Date', 'date'),
      f('Sync_Status__c', 'Sync Status', 'picklist', { values: ['Pending', 'Synced', 'Failed'], createable: false }),
    ],
    children: [],
  },
  Order_Event__e: {
    label: 'Order Event', keyPrefix: 'e00', custom: true, isEvent: true,
    fields: [
      f('Order_Number__c', 'Order Number', 'string', { length: 40, required: true }),
      f('Status__c', 'Status', 'string', { length: 40 }),
      f('Amount__c', 'Amount', 'number', { precision: 16, scale: 2 }),
    ],
    children: [],
  },
};

// Low-privilege user restrictions (simulated sharing / FLS / CRUD).
const LOW_PRIV = {
  noAccessObjects: ['Invoice__c'],
  readOnlyObjects: ['Account', 'Opportunity'],
  hiddenFields: { Contact: ['Birthdate'], Account: ['AnnualRevenue'] },
};

function describe(name) {
  const o = OBJECTS[name];
  if (!o) return null;
  return {
    name, label: o.label, keyPrefix: o.keyPrefix, custom: o.custom,
    createable: true, updateable: !o.isEvent, deletable: !o.isEvent, queryable: !o.isEvent,
    fields: o.fields.map((x) => ({ ...x })),
    childRelationships: o.children,
    recordTypeInfos: [{ name: 'Master', developerName: 'Master', active: true, defaultRecordTypeMapping: true }],
  };
}

module.exports = { OBJECTS, LOW_PRIV, describe };
