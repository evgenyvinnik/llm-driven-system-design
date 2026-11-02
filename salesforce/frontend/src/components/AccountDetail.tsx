import { useState, useEffect } from 'react';
import type { Account, Contact, Opportunity, Activity } from '../types';
import { accountsApi, activitiesApi } from '../services/api';
import { StatusBadge } from './StatusBadge';
import { ActivityTimeline } from './ActivityTimeline';
import { ActivityForm } from './ActivityForm';
import { formatCalendarDate } from '../utils/dates';

interface AccountDetailProps {
  accountId: string;
}

function formatCurrency(cents: number | null): string {
  if (!cents) return '-';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
  }).format(cents / 100);
}

type Tab = 'contacts' | 'opportunities' | 'activities';

/** Renders an account detail view with tabbed sub-views for contacts, opportunities, and activities. */
export function AccountDetail({ accountId }: AccountDetailProps) {
  const [account, setAccount] = useState<Account | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>('contacts');
  const [loading, setLoading] = useState(true);
  const [showActivityForm, setShowActivityForm] = useState(false);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const [accountData, contactsData, oppsData, activitiesData] = await Promise.all([
          accountsApi.get(accountId),
          accountsApi.getContacts(accountId),
          accountsApi.getOpportunities(accountId),
          activitiesApi.list({ relatedType: 'account', relatedId: accountId }),
        ]);
        setAccount(accountData.account);
        setContacts(contactsData.contacts);
        setOpportunities(oppsData.opportunities);
        setActivities(activitiesData.activities);
      } catch {
        // error handled
      }
      setLoading(false);
    }
    load();
  }, [accountId]);

  if (loading) {
    return <div className="text-center py-8 text-salesforce-secondary">Loading...</div>;
  }

  if (!account) {
    return <div className="text-center py-8 text-salesforce-secondary">Account not found</div>;
  }

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: 'contacts', label: 'Contacts', count: contacts.length },
    { key: 'opportunities', label: 'Opportunities', count: opportunities.length },
    { key: 'activities', label: 'Activities', count: activities.length },
  ];

  return (
    <div>
      <div className="bg-white rounded-lg shadow-sm border border-salesforce-border p-6 mb-4">
        <h2 className="text-2xl font-bold text-salesforce-text mb-4">{account.name}</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <span className="text-salesforce-secondary">Industry</span>
            <p className="font-medium">{account.industry || '-'}</p>
          </div>
          <div>
            <span className="text-salesforce-secondary">Website</span>
            <p className="font-medium">{account.website || '-'}</p>
          </div>
          <div>
            <span className="text-salesforce-secondary">Phone</span>
            <p className="font-medium">{account.phone || '-'}</p>
          </div>
          <div>
            <span className="text-salesforce-secondary">Annual Revenue</span>
            <p className="font-medium">{formatCurrency(account.annual_revenue_cents)}</p>
          </div>
          <div>
            <span className="text-salesforce-secondary">Employees</span>
            <p className="font-medium">{account.employee_count?.toLocaleString() || '-'}</p>
          </div>
          <div>
            <span className="text-salesforce-secondary">Owner</span>
            <p className="font-medium">{account.owner_name || '-'}</p>
          </div>
          <div className="col-span-2">
            <span className="text-salesforce-secondary">Address</span>
            <p className="font-medium">
              {[account.address_street, account.address_city, account.address_state, account.address_country]
                .filter(Boolean)
                .join(', ') || '-'}
            </p>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-salesforce-border">
        <div className="border-b border-salesforce-border">
          <nav className="flex">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === tab.key
                    ? 'border-salesforce-primary text-salesforce-primary'
                    : 'border-transparent text-salesforce-secondary hover:text-salesforce-text'
                }`}
              >
                {tab.label} ({tab.count})
              </button>
            ))}
          </nav>
        </div>

        <div className="p-4">
          {activeTab === 'contacts' && (
            <div>
              {contacts.length === 0 ? (
                <p className="text-salesforce-secondary text-center py-4">No contacts</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="text-left py-2 font-medium text-salesforce-secondary">Name</th>
                      <th className="text-left py-2 font-medium text-salesforce-secondary">Title</th>
                      <th className="text-left py-2 font-medium text-salesforce-secondary">Email</th>
                      <th className="text-left py-2 font-medium text-salesforce-secondary">Phone</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contacts.map((c) => (
                      <tr key={c.id} className="border-b border-gray-50">
                        <td className="py-2 font-medium text-salesforce-primary">{c.first_name} {c.last_name}</td>
                        <td className="py-2">{c.title || '-'}</td>
                        <td className="py-2">{c.email || '-'}</td>
                        <td className="py-2">{c.phone || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {activeTab === 'opportunities' && (
            <div>
              {opportunities.length === 0 ? (
                <p className="text-salesforce-secondary text-center py-4">No opportunities</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="text-left py-2 font-medium text-salesforce-secondary">Name</th>
                      <th className="text-left py-2 font-medium text-salesforce-secondary">Stage</th>
                      <th className="text-left py-2 font-medium text-salesforce-secondary">Amount</th>
                      <th className="text-left py-2 font-medium text-salesforce-secondary">Close Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {opportunities.map((o) => (
                      <tr key={o.id} className="border-b border-gray-50">
                        <td className="py-2 font-medium text-salesforce-primary">{o.name}</td>
                        <td className="py-2"><StatusBadge status={o.stage} type="opportunity" /></td>
                        <td className="py-2">{formatCurrency(o.amount_cents)}</td>
                        <td className="py-2">{formatCalendarDate(o.close_date)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {activeTab === 'activities' && (
            <div>
              <button
                onClick={() => setShowActivityForm(!showActivityForm)}
                className="mb-4 px-3 py-1.5 bg-salesforce-primary text-white rounded text-sm hover:bg-salesforce-hover"
              >
                Log Activity
              </button>
              {showActivityForm && (
                <ActivityForm
                  relatedType="account"
                  relatedId={accountId}
                  onSaved={async () => {
                    setShowActivityForm(false);
                    const data = await activitiesApi.list({ relatedType: 'account', relatedId: accountId });
                    setActivities(data.activities);
                  }}
                  onCancel={() => setShowActivityForm(false)}
                />
              )}
              <ActivityTimeline activities={activities} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
