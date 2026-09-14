import React, { useState, useMemo, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { DashboardData, Employee } from '@/shared/types';
import { getShortName, triggerHaptic } from '@/core/utils/helpers';
import Avatar from '@/shared/components/common/Avatar';
import ModalContactDetail from '@/modules/tms/components/ModalContactDetail';
import { STORAGE_KEYS, TMS_LIMITS } from '@/shared/constants';
import { buildLocationNameMap } from '@/modules/tms/services/locations';
import { type RegisterSwipeHandler, type TabType } from '@/modules/tms/components/BottomNav';

interface Props {
    data: DashboardData | null;
    user: Employee;
    resetTrigger?: number;
    searchTrigger?: number; // Header Search Trigger
    setIsHeaderVisible?: (visible: boolean) => void;
    registerSwipeHandler?: RegisterSwipeHandler;
    onNavigate: (tab: TabType) => void;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const HighlightText: React.FC<{ text: string; highlight: string }> = ({ text, highlight }) => {
    if (!highlight.trim()) return <span>{text}</span>;

    const parts = text.split(new RegExp(`(${escapeRegExp(highlight)})`, 'gi'));
    return (
        <span>
            {parts.map((part, index) =>
                part.toLowerCase() === highlight.toLowerCase() ? (
                    <span key={`${part}-${index}`} className="ui-mark">{part}</span>
                ) : (
                    <span key={`${part}-${index}`}>{part}</span>
                )
            )}
        </span>
    );
};

/** Department tiles only need to look different from each other — nothing is
 *  being reported — so they cycle the identity tones, not the status ones.
 *  The colours themselves live in style.css; this list is class names only. */
const GROUP_TONES = ['ui-tone-brand-1', 'ui-tone-brand-2', 'ui-tone-brand-3', 'ui-tone-brand-4'] as const;

const groupIcon = (groupId: string) => {
    if (groupId.startsWith('grp_director')) return 'shield_person';
    if (groupId.startsWith('grp_manager')) return 'hub';
    if (groupId.startsWith('grp_leader')) return 'star';
    if (groupId.startsWith('grp_team')) return 'groups';
    return 'badge';
};

const TabContacts: React.FC<Props> = ({ data, user, resetTrigger = 0, searchTrigger = 0, setIsHeaderVisible, registerSwipeHandler, onNavigate }) => {
    const [term, setTerm] = useState('');
    const [debouncedTerm, setDebouncedTerm] = useState('');
    const [selectedContact, setSelectedContact] = useState<Employee | null>(null);
    const [activeCenter, setActiveCenter] = useState<string>('Tất cả');
    const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);

    const toggleGroup = (groupId: string) => {
        triggerHaptic('light');
        setExpandedGroupId(prev => prev === groupId ? null : groupId);
    };

    const [cachedContacts, setCachedContacts] = useState<Employee[]>(() => {
        try {
            const cached = localStorage.getItem(STORAGE_KEYS.CONTACTS_CACHE);
            if (!cached) return [];
            const parsed: unknown = JSON.parse(cached);
            if (!parsed || typeof parsed !== 'object') return [];
            const envelope = parsed as { ownerId?: unknown; contacts?: unknown };
            return envelope.ownerId === user.employee_id && Array.isArray(envelope.contacts)
                ? envelope.contacts as Employee[]
                : [];
        } catch (e) {
            console.error("Failed to load contacts cache", e);
            return [];
        }
    });

    const inputRef = useRef<HTMLInputElement>(null);
    const tabsRef = useRef<HTMLDivElement>(null);
    const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

    const locationsMap = useMemo(() => buildLocationNameMap(data), [data]);

    const contacts = useMemo(() => {
        const allContacts = ((data?.contacts && data.contacts.length > 0) ? data.contacts : cachedContacts).filter(c => c.role !== 'Kiosk');

        const userProfile = data?.userProfile;
        if (!userProfile) return allContacts;

        // 1. Collect all relevant location IDs for the user
        const userLocations = new Set<string>();
        if (userProfile.center_id) userLocations.add(userProfile.center_id);
        if (Array.isArray(userProfile.managed_locations)) {
            userProfile.managed_locations.forEach(loc => userLocations.add(loc));
        }

        // 2. Extract unique prefixes (e.g., "DN01" -> "DN")
        const allowedPrefixes = Array.from(userLocations).map(loc => loc.replace(/[0-9]/g, ''));
        const uniquePrefixes = Array.from(new Set(allowedPrefixes)).filter(Boolean);

        // 3. If no prefixes found (shouldn't happen), show all or none? Let's show all as fallback.
        if (uniquePrefixes.length === 0) return allContacts;

        // 4. Filter contacts: center_id prefix must match one of user's prefixes
        return allContacts.filter(c => {
            if (!c.center_id) return false;
            const contactPrefix = c.center_id.replace(/[0-9]/g, '');
            return uniquePrefixes.includes(contactPrefix);
        });
    }, [data?.contacts, cachedContacts, data?.userProfile]);

    const centers = useMemo(() => {
        const centerSet = new Set<string>();
        contacts.forEach(c => {
            const centerName = locationsMap[c.center_id] || c.center_id || 'Khác';
            centerSet.add(centerName);
        });

        // Sort centers: 'Tất cả' first, then follow managed_locations order if available, else alphabetical
        const sortedCenters = Array.from(centerSet).sort((a, b) => {
            const managed = data?.userProfile?.managed_locations || [];
            // Map location names back to IDs if possible, or just sort alphabetically
            // Since we only have names here, let's try to find the ID from locationsMap
            const idA = Object.keys(locationsMap).find(key => locationsMap[key] === a);
            const idB = Object.keys(locationsMap).find(key => locationsMap[key] === b);

            if (managed.length > 0 && idA && idB) {
                const idxA = managed.indexOf(idA);
                const idxB = managed.indexOf(idB);
                if (idxA !== -1 && idxB !== -1) return idxA - idxB;
                if (idxA !== -1) return -1;
                if (idxB !== -1) return 1;
            }
            return a.localeCompare(b);
        });

        return ['Tất cả', ...sortedCenters];
    }, [contacts, locationsMap, data?.userProfile?.managed_locations]);

    useEffect(() => {
        if (activeCenter && tabsRef.current) {
            const tab = tabRefs.current.get(activeCenter);
            if (tab) {
                tab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
            }
        }
    }, [activeCenter]);

    useEffect(() => {
        if (registerSwipeHandler) {
            return registerSwipeHandler((direction) => {
                if (term || selectedContact) return false; // Branch swiping would fight the search results

                const currentIndex = centers.indexOf(activeCenter);

                if (direction === 'left') {
                    const nextCenter = centers[currentIndex + 1];
                    if (currentIndex >= 0 && nextCenter) {
                        triggerHaptic('light');
                        setActiveCenter(nextCenter);
                        return true;
                    }
                }

                if (direction === 'right') {
                    const previousCenter = centers[currentIndex - 1];
                    if (currentIndex > 0 && previousCenter) {
                        triggerHaptic('light');
                        setActiveCenter(previousCenter);
                        return true;
                    }
                }

                return false;
            });
        }
        return undefined;
    }, [registerSwipeHandler, activeCenter, centers, term, selectedContact]);

    useEffect(() => {
        if (searchTrigger > 0) {
            handleStartSearch();
        }
    }, [searchTrigger]);

    useEffect(() => {
        if (resetTrigger > 0) {
            if (selectedContact) {
                if (window.history.state && window.history.state.view === 'contact-detail') {
                    window.history.back();
                } else {
                    setSelectedContact(null);
                }
            }
            setTerm('');
            setDebouncedTerm('');
            if (setIsHeaderVisible) setIsHeaderVisible(true);
        }
    }, [resetTrigger]);

    useEffect(() => {
        return () => {
            if (setIsHeaderVisible) setIsHeaderVisible(true);
        };
    }, []);

    const handleOpenContact = (c: Employee) => {
        triggerHaptic('light');
        window.history.pushState({ view: 'contact-detail', id: c.employee_id }, '');
        setSelectedContact(c);
        if (setIsHeaderVisible) setIsHeaderVisible(false);
    };

    const handleCloseContact = () => {
        triggerHaptic('light');
        if (window.history.state && window.history.state.view === 'contact-detail') {
            window.history.back();
        } else {
            setSelectedContact(null);
            if (setIsHeaderVisible) setIsHeaderVisible(true);
        }
    };

    useEffect(() => {
        const handlePopState = () => {
            if (selectedContact) {
                setSelectedContact(null);
                if (setIsHeaderVisible) setIsHeaderVisible(true);
            }
        };
        window.addEventListener('popstate', handlePopState);
        return () => window.removeEventListener('popstate', handlePopState);
    }, [selectedContact, setIsHeaderVisible]);

    useEffect(() => {
        if (data?.contacts && data.contacts.length > 0) {
            try {
                localStorage.setItem(STORAGE_KEYS.CONTACTS_CACHE, JSON.stringify({
                    ownerId: user.employee_id,
                    contacts: data.contacts,
                }));
                setCachedContacts(data.contacts);
            } catch (e) {
                console.error("Failed to save contacts cache", e);
            }
        }
    }, [data?.contacts, user.employee_id]);

    useEffect(() => {
        const handler = setTimeout(() => {
            setDebouncedTerm(term);
        }, TMS_LIMITS.CONTACT_SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(handler);
    }, [term]);

    const { empNameMap, empRoleMap, empDeptMap } = useMemo(() => {
        const nameMap: Record<string, string> = {};
        const roleMap: Record<string, string> = {};
        const deptMap: Record<string, string> = {};
        // Use allContacts (data.contacts) for mapping to ensure we find managers even if filtered out of view
        const source = data?.contacts || [];
        source.forEach(c => {
            nameMap[c.employee_id] = c.name;
            roleMap[c.employee_id] = c.role;
            deptMap[c.employee_id] = c.department || '';
        });
        return { empNameMap: nameMap, empRoleMap: roleMap, empDeptMap: deptMap };
    }, [data?.contacts]);

    const filtered = useMemo(() => {
        if (!debouncedTerm) return [];
        const normTerm = debouncedTerm.toLowerCase();
        return contacts.filter(c =>
            c.name.toLowerCase().includes(normTerm) ||
            String(c.phone || '').includes(normTerm) ||
            (c.department && c.department.toLowerCase().includes(normTerm)) ||
            (c.position && c.position.toLowerCase().includes(normTerm)) ||
            (c.email && c.email.toLowerCase().includes(normTerm))
        );
    }, [contacts, debouncedTerm]);

    const contactsInActiveCenter = useMemo(() => {
        if (activeCenter === 'Tất cả') return contacts;
        return contacts.filter(c => {
            const centerName = locationsMap[c.center_id] || c.center_id || 'Khác';
            return centerName === activeCenter;
        });
    }, [contacts, activeCenter, locationsMap]);

    const contactGroups = useMemo(() => {
        const groups: Record<string, { id: string, title: string, priority: number, contacts: Employee[], managerId?: string }> = {};

        const getRolePriority = (role: string) => {
            if (role === 'Director') return 0;
            if (role === 'Manager') return 1;
            if (role === 'Leader') return 2;
            if (role === 'Admin' || role === 'HR') return 3;
            return 4;
        };

        const addToGroup = (id: string, title: string, priority: number, contact: Employee, managerId?: string) => {
            const group = groups[id] ?? { id, title, priority, contacts: [], managerId };
            group.contacts.push(contact);
            groups[id] = group;
        };

        contactsInActiveCenter.forEach(c => {
            if (c.role === 'Director') {
                addToGroup('grp_director', 'Ban Giám Đốc', 0, c);
            } else if (c.role === 'Manager') {
                if (c.direct_manager_id && empNameMap[c.direct_manager_id]) {
                    const mgrName = getShortName(empNameMap[c.direct_manager_id] || '');
                    addToGroup(`grp_manager_${c.direct_manager_id}`, `Ban Quản Lý - ${mgrName}`, 1, c, c.direct_manager_id);
                } else {
                    addToGroup('grp_manager', 'Ban Quản Lý', 1, c);
                }
            } else if (c.direct_manager_id && empNameMap[c.direct_manager_id]) {
                const managerId = c.direct_manager_id;
                const mgrName = getShortName(empNameMap[managerId] || '');
                const dept = c.department || empDeptMap[managerId] || '';
                const title = dept ? `${dept} - ${mgrName}` : mgrName;
                addToGroup(`grp_team_${managerId}`, title, 2 + getRolePriority(c.role), c, managerId);
            } else {
                if (c.role === 'Leader') {
                    addToGroup('grp_leader', 'Trưởng Nhóm', 10, c);
                } else {
                    addToGroup('grp_staff', 'Nhân Viên', 999, c);
                }
            }
        });

        // Inject managers into their groups so they appear at the top
        Object.values(groups).forEach(g => {
            if (g.managerId) {
                const manager = data?.contacts?.find(emp => emp.employee_id === g.managerId);
                if (manager) {
                    // Check if manager is already in the group
                    if (!g.contacts.some(emp => emp.employee_id === manager.employee_id)) {
                        g.contacts.push(manager);
                    }
                }
            }
        });

        // Sort groups: explicit priority first, and ensure 'Nhân Viên' (grp_staff) is strictly placed at the very bottom
        const sorted = Object.values(groups).sort((a, b) => {
            const isStaffA = a.id === 'grp_staff' || a.title.trim().toLowerCase() === 'nhân viên';
            const isStaffB = b.id === 'grp_staff' || b.title.trim().toLowerCase() === 'nhân viên';
            if (isStaffA && !isStaffB) return 1;
            if (!isStaffA && isStaffB) return -1;

            if (a.priority !== b.priority) return a.priority - b.priority;
            return a.title.localeCompare(b.title);
        });

        // Sort contacts within groups: Manager first -> Role Priority -> Employee Name
        sorted.forEach(g => {
            g.contacts.sort((a, b) => {
                // 1. Check if either is the explicit manager of the group
                const isManagerA = a.employee_id === g.managerId;
                const isManagerB = b.employee_id === g.managerId;

                // 2. Check if either is a local manager (manages someone else in this specific group, e.g. in Ban Giám Đốc)
                const isLocalManagerA = g.contacts.some(c => c.direct_manager_id === a.employee_id);
                const isLocalManagerB = g.contacts.some(c => c.direct_manager_id === b.employee_id);

                const isTopA = isManagerA || isLocalManagerA;
                const isTopB = isManagerB || isLocalManagerB;

                if (isTopA && !isTopB) return -1;
                if (!isTopA && isTopB) return 1;

                // 3. Sort by role priority
                const prioA = getRolePriority(a.role);
                const prioB = getRolePriority(b.role);
                if (prioA !== prioB) return prioA - prioB;

                // 4. Sort alphabetically
                return a.name.localeCompare(b.name);
            });
        });

        return sorted;
    }, [contactsInActiveCenter, locationsMap, empNameMap, empRoleMap, empDeptMap, data?.contacts]);

    // Initialize expandedGroupId with the first group ID when contactGroups changes
    useEffect(() => {
        if (contactGroups && contactGroups.length > 0) {
            // If the currently expanded group is not in the new list, or if nothing is expanded, expand the first one
            setExpandedGroupId(prev => {
                if (prev && contactGroups.some(g => g.id === prev)) {
                    return prev;
                }
                return contactGroups[0]?.id || null;
            });
        } else {
            setExpandedGroupId(null);
        }
    }, [contactGroups]);

    // The search field is always on screen now, so the header's search action just
    // moves focus into it instead of swapping the page into a separate search mode.
    const handleStartSearch = () => {
        triggerHaptic('light');
        inputRef.current?.focus();
    };

    const handleCancelSearch = () => {
        triggerHaptic('light');
        setTerm('');
        setDebouncedTerm('');
        inputRef.current?.blur();
    };

    const directory = useMemo(() => {
        const total = contactsInActiveCenter.length;
        const active = contactsInActiveCenter.filter(c => c.status === 'Active').length;
        return { total, active, groups: contactGroups.length };
    }, [contactsInActiveCenter, contactGroups]);

    const centerCounts = useMemo(() => {
        const counts: Record<string, number> = { 'Tất cả': contacts.length };
        contacts.forEach(c => {
            const centerName = locationsMap[c.center_id] || c.center_id || 'Khác';
            counts[centerName] = (counts[centerName] || 0) + 1;
        });
        return counts;
    }, [contacts, locationsMap]);

    const renderPerson = (c: Employee, highlight?: string) => {
        const centerName = locationsMap[c.center_id] || c.center_id;
        const phone = c.phone ? String(c.phone) : '';
        const presence = c.status === 'Active' ? 'ui-person-dot-active' : '';
        return (
            <div key={c.employee_id} className="ui-person">
                <button
                    type="button"
                    className="ui-person-figure"
                    aria-label={`Xem hồ sơ ${c.name}`}
                    onClick={() => handleOpenContact(c)}
                >
                    <Avatar src={c.face_ref_url} name={c.name} className="w-11 h-11 rounded-2xl" textSize="text-xs" />
                    <span className={`ui-person-dot ${presence}`.trim()} aria-hidden="true" />
                </button>

                <div className="ui-person-body" role="button" tabIndex={0}
                    onClick={() => handleOpenContact(c)}
                    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); handleOpenContact(c); } }}
                >
                    <span className="ui-person-name">
                        {highlight ? <HighlightText text={c.name} highlight={highlight} /> : c.name}
                    </span>
                    {c.position ? (
                        <span className="ui-person-tags">
                            <span className="ui-pill ui-pill-muted">
                                {highlight ? <HighlightText text={c.position} highlight={highlight} /> : c.position}
                            </span>
                        </span>
                    ) : null}
                    <span className="ui-person-meta">
                        {c.department ? <span className="ui-person-meta-strong">{c.department}</span> : null}
                        {c.department && centerName ? <span aria-hidden="true">•</span> : null}
                        {centerName ? <span>{centerName}</span> : null}
                    </span>
                </div>

                <div className="ui-person-actions">
                    <a
                        className={`ui-person-action ${phone ? '' : 'ui-person-action-disabled'}`.trim()}
                        href={phone ? `tel:${phone}` : undefined}
                        aria-label={phone ? `Gọi ${c.name}` : 'Chưa có số điện thoại'}
                        aria-disabled={phone ? undefined : true}
                        onClick={(event) => { if (!phone) event.preventDefault(); }}
                    >
                        <span className="material-symbols-rounded" aria-hidden="true">call</span>
                    </a>
                    <a
                        className={`ui-person-action ${c.email ? '' : 'ui-person-action-disabled'}`.trim()}
                        href={c.email ? `mailto:${c.email}` : undefined}
                        aria-label={c.email ? `Gửi email cho ${c.name}` : 'Chưa có email'}
                        aria-disabled={c.email ? undefined : true}
                        onClick={(event) => { if (!c.email) event.preventDefault(); }}
                    >
                        <span className="material-symbols-rounded" aria-hidden="true">mail</span>
                    </a>
                    <button
                        type="button"
                        className="ui-person-action ui-person-action-accent"
                        aria-label={`Xem hồ sơ ${c.name}`}
                        onClick={() => handleOpenContact(c)}
                    >
                        <span className="material-symbols-rounded" aria-hidden="true">badge</span>
                    </button>
                </div>
            </div>
        );
    };

    return (
        <div className="contacts-page absolute inset-0 flex flex-col page-bg font-sans transition-colors duration-300">
            <div className="contacts-toolbar">
                <div className="ui-search">
                    <span className="material-symbols-rounded" aria-hidden="true">search</span>
                    <input
                        ref={inputRef}
                        type="text"
                        inputMode="search"
                        enterKeyHint="search"
                        aria-label="Tìm kiếm danh bạ"
                        placeholder="Tìm tên, vị trí, email hoặc ban…"
                        value={term}
                        onChange={e => setTerm(e.target.value)}
                    />
                    {term ? (
                        <button type="button" className="ui-search-clear" aria-label="Xóa nội dung tìm kiếm" onClick={handleCancelSearch}>
                            <span className="material-symbols-rounded" aria-hidden="true">close</span>
                        </button>
                    ) : null}
                </div>

                {!term && (
                    <div className="ui-chips contacts-chips" ref={tabsRef}>
                        {centers.map(center => (
                            <button
                                key={center}
                                type="button"
                                aria-pressed={activeCenter === center}
                                ref={(el) => {
                                    if (el) tabRefs.current.set(center, el);
                                    else tabRefs.current.delete(center);
                                }}
                                onClick={() => { triggerHaptic('light'); setActiveCenter(center); }}
                                className={`ui-chip ${activeCenter === center ? 'ui-chip-active' : ''}`.trim()}
                            >
                                {center !== 'Tất cả' ? <span className="ui-chip-dot" aria-hidden="true" /> : null}
                                <span>{center}</span>
                                <span className="ui-chip-count">{centerCounts[center] ?? 0}</span>
                            </button>
                        ))}
                    </div>
                )}
            </div>

            <div className="contacts-results hide-scroll">
                {term ? (
                    <div className="ui-stack animate-fade-in">
                        <div className="ui-label-row">
                            <span className="ui-label">Kết quả tìm kiếm</span>
                            <span className="ui-label">{term === debouncedTerm ? `${filtered.length} người` : '…'}</span>
                        </div>
                        {term !== debouncedTerm ? (
                            <div className="ui-empty">
                                <span className="material-symbols-rounded animate-spin" aria-hidden="true">progress_activity</span>
                                <span className="ui-empty-title">Đang tìm kiếm…</span>
                            </div>
                        ) : filtered.length === 0 ? (
                            <div className="ui-empty">
                                <span className="material-symbols-rounded" aria-hidden="true">search_off</span>
                                <span className="ui-empty-title">Không tìm thấy kết quả</span>
                                <span className="ui-empty-text">Thử tìm theo tên, phòng ban hoặc email công vụ.</span>
                            </div>
                        ) : (
                            <div className="ui-card ui-card-flush">
                                {filtered.map(c => renderPerson(c, debouncedTerm))}
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="ui-stack animate-slide-up">
                        <div className="ui-card">
                            <div className="ui-stat-strip">
                                <div className="ui-stat">
                                    <span className="ui-stat-value">{directory.total}</span>
                                    <span className="ui-stat-label">Tổng nhân sự</span>
                                </div>
                                <div className="ui-stat">
                                    <span className="ui-stat-value ui-tone-success">
                                        <span className="ui-stat-dot" aria-hidden="true" />
                                        {directory.active}
                                    </span>
                                    <span className="ui-stat-label">Đang hoạt động</span>
                                </div>
                                <div className="ui-stat">
                                    <span className="ui-stat-value">{directory.groups}</span>
                                    <span className="ui-stat-label">Phòng ban</span>
                                </div>
                            </div>
                        </div>

                        {contactGroups.length === 0 ? (
                            <div className="ui-empty">
                                <span className="material-symbols-rounded" aria-hidden="true">group_off</span>
                                <span className="ui-empty-title">Chưa có nhân sự</span>
                                <span className="ui-empty-text">Không có ai trong phạm vi chi nhánh đang chọn.</span>
                            </div>
                        ) : contactGroups.map((group, index) => {
                            const isExpanded = expandedGroupId === group.id;
                            const tone = GROUP_TONES[index % GROUP_TONES.length] ?? 'ui-tone-brand-1';
                            return (
                                <div key={group.id} className="ui-card">
                                    <button
                                        type="button"
                                        className="ui-card-head"
                                        aria-expanded={isExpanded}
                                        onClick={() => toggleGroup(group.id)}
                                    >
                                        <span className={`ui-tile ${tone}`} aria-hidden="true">
                                            <span className="material-symbols-rounded">{groupIcon(group.id)}</span>
                                        </span>
                                        <span className="ui-card-head-text">
                                            <span className="ui-card-head-title">{group.title}</span>
                                        </span>
                                        <span className="ui-pill ui-pill-primary">{group.contacts.length}</span>
                                        <span className={`ui-card-head-chevron material-symbols-rounded ${isExpanded ? 'ui-card-head-chevron-open' : ''}`.trim()} aria-hidden="true">expand_more</span>
                                    </button>

                                    <AnimatePresence initial={false}>
                                        {isExpanded && (
                                            <motion.div
                                                initial={{ height: 0, opacity: 0 }}
                                                animate={{ height: 'auto', opacity: 1 }}
                                                exit={{ height: 0, opacity: 0 }}
                                                transition={{ duration: 0.2 }}
                                                className="overflow-hidden"
                                            >
                                                <div className="ui-card-section">
                                                    {group.contacts.map(c => renderPerson(c))}
                                                </div>
                                            </motion.div>
                                        )}
                                    </AnimatePresence>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            <ModalContactDetail
                contact={selectedContact}
                isOpen={!!selectedContact}
                onClose={handleCloseContact}
                locationsMap={locationsMap}
                empNameMap={empNameMap}
                locations={data?.locations || []}
                onNavigate={onNavigate}
            />
        </div>
    );
};

export default TabContacts;
