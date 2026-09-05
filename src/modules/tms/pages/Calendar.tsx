import React, { useState, useMemo, useEffect } from 'react';
import { DashboardData, Employee } from '@/shared/types';
import { toISODateString } from '@/core/utils/helpers';
import PullToRefresh from '@/shared/components/layout/PullToRefresh';
import ModalOffList from '@/modules/tms/components/ModalOffList';
import type { LeaveGroup } from '@/modules/tms/components/ModalOffList';
import type { LeaveRequest } from '@/shared/types';

interface Props {
  data: DashboardData | null;
  user: Employee;
  onRefresh: () => Promise<void>;
  currentDate: Date;
}

const CalendarPage: React.FC<Props> = ({ data, user, onRefresh, currentDate }) => {
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [expandedLeaveGroup, setExpandedLeaveGroup] = useState<string | null>(null);

  const teamLeaves = data?.teamLeaves || [];
  const contacts = data?.contacts || [];

  const locationsMap = useMemo(() => {
    const map: Record<string, string> = {};
    data?.locations.forEach(l => map[l.center_id] = l.location_name);
    return map;
  }, [data?.locations]);

  const generateCalendar = () => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const days: Array<Date | null> = [];
    for (let i = 0; i < firstDay; i++) days.push(null);
    for (let i = 1; i <= daysInMonth; i++) days.push(new Date(year, month, i));

    return days;
  };

  const getLeavesForDate = (date: Date) => {
    const dateStr = toISODateString(date);
    return teamLeaves.filter(l => l.from_date <= dateStr && l.to_date >= dateStr);
  };

  const selectedDateLeaves = useMemo(() => {
    const dateStr = toISODateString(selectedDate);
    const onLeaveOnDate = teamLeaves.filter(l => l.from_date <= dateStr && l.to_date >= dateStr);

    const userManagedLocations = new Set<string>(user.managed_locations || []);
    if (user.center_id) userManagedLocations.add(user.center_id);

    const filtered = onLeaveOnDate.filter(l => {
        const emp = contacts.find(c => c.employee_id === l.employee_id);
        if (!emp || !emp.center_id) return false;

        const isDirectReport = String(emp.direct_manager_id) === String(user.employee_id);
        const isInManagedLocation = userManagedLocations.has(emp.center_id);

        if (user.role === 'Admin' || user.role === 'HR') {
          return true;
        }

        return isDirectReport || isInManagedLocation;
    });

    const groups: Record<string, Array<LeaveRequest & { emp?: Employee }>> = {};
    filtered.forEach(l => {
        const emp = contacts.find(c => c.employee_id === l.employee_id);
        const centerId = emp?.center_id || 'Unknown Center';
        const centerName = locationsMap[centerId] || centerId;
        const group = groups[centerName] ?? [];
        group.push({ ...l, emp });
        groups[centerName] = group;
    });

    return groups;
}, [teamLeaves, contacts, user, locationsMap, selectedDate]);

  const leaveGroups = useMemo<LeaveGroup[]>(() => {
    return Object.keys(selectedDateLeaves).map(centerName => ({
        id: centerName,
        title: centerName,
        items: selectedDateLeaves[centerName] ?? []
    }));
  }, [selectedDateLeaves]);

  useEffect(() => {
    if (leaveGroups.length > 0) {
        setExpandedLeaveGroup(prev => {
            if (prev && leaveGroups.some(g => g.id === prev)) return prev;
            return leaveGroups[0]?.id || null;
        });
    } else {
        setExpandedLeaveGroup(null);
    }
  }, [leaveGroups]);

  const getTypeConfig = (type: string, isLeave: boolean) => {
    if (!isLeave) return { label: 'Giải trình công', tone: 'info' };
    if (type.includes('Nghỉ phép')) return { label: type, tone: 'primary' };
    if (type.includes('Nghỉ ốm')) return { label: type, tone: 'danger' };
    if (type.includes('Nghỉ không lương')) return { label: type, tone: 'warning' };
    if (type.includes('Làm việc tại nhà')) return { label: type, tone: 'success' };
    if (type.includes('Công tác')) return { label: type, tone: 'info' };
    return { label: type, tone: 'muted' };
  };

  return (
    <PullToRefresh onRefresh={onRefresh} className="page-bg font-sans">
      <div className="employee-page employee-page-standard calendar-page animate-fade-in space-y-8">
        <ModalOffList
          leaveGroups={leaveGroups}
          expandedLeaveGroup={expandedLeaveGroup}
          setExpandedLeaveGroup={setExpandedLeaveGroup}
          generateCalendar={generateCalendar}
          getLeavesForDate={getLeavesForDate}
          getTypeConfig={getTypeConfig}
          selectedDate={selectedDate}
          setSelectedDate={setSelectedDate}
        />
      </div>
    </PullToRefresh>
  );
};

export default CalendarPage;
