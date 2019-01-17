///<reference path="../node_modules/grafana-sdk-mocks/app/headers/common.d.ts" />

import _ from 'lodash';
import {PanelCtrl} from 'app/plugins/sdk';
import moment from 'moment';

import './css/annolist.css';

class AnnoListCtrl extends PanelCtrl {
  static templateUrl = 'partials/module.html';
  static scrollable = true;

  found: any[] = [];
  timeInfo?: string; // TODO shoudl be defined in Types
  availableDatasources: string[];
  defaultDatasource: string = '-- Grafana --';

  queryUserId?: number;
  queryUser?: string;

  static panelDefaults = {
    limit: 10,
    tags: [],
    onlyFromThisDashboard: false,

    showTags: true,
    showUser: true,
    showTime: true,

    navigateBefore: '10m',
    navigateAfter: '10m',
    navigateToPanel: true,
    navigateToDashboard: true,

    selectedDatasource: '-- Grafana --',
  };

  /** @ngInject */
  constructor(
    $scope,
    $injector,
    private $rootScope,
    private backendSrv,
    private datasourceSrv,
    private timeSrv,
    private $location
  ) {
    super($scope, $injector);
    _.defaults(this.panel, AnnoListCtrl.panelDefaults);

    $scope.moment = moment;

    this.events.on('refresh', this.onRefresh.bind(this));
    this.events.on('init-edit-mode', this.onInitEditMode.bind(this));

  }

  onInitEditMode() {
    // Get InfluxDB datasource and defaultDatasource
    var availableDatasources: any[];
    availableDatasources = _.filter(this.datasourceSrv.datasources, {'type': 'influxdb'});
    availableDatasources = availableDatasources.map(function(v) {
      return v.name;
    });
    availableDatasources.push(this.defaultDatasource);
    this.availableDatasources = availableDatasources;

    this.editorTabIndex = 1;
    this.addEditorTab(
      'Options',
      'public/plugins/ryantxu-annolist-panel/partials/editor.html'
    );
  }

  onRefresh() {
    var promises: Promise<any>[] = [];

    promises.push(this.getAnnotationSearch());

    return Promise.all(promises).then(this.renderingCompleted.bind(this));
  }

  _promiseAnnotationFromInfluxDB(params: any): Promise<any> {
    const zip = (array1, array2) => array1.map((_, i) => [array1[i], array2[i]]);

    let where = ' WHERE 1 = 1 ';
    // tags expr
    if (params.tags.length) {
      let expr = '/';
      params.tags.forEach(function(v) {
        expr += v + '(,|$)|';
      });
      expr = expr.slice(0, -1) + '/';
      where += ' AND tags =~ ' + expr;
    }

    if (params.from) {
      // RFC3339
      where += ' AND (' + params.from + '000000 <= time AND time <= ' + params.to + '000000)';
    }

    if (params.dashboardId) {
      where += ' AND dashboardId = ' + params.dashboardId;
    }

    if (params.userId) {
      where += ' AND userId = ' + params.userId;
    }

    const limit = ' LIMIT ' + this.panel.limit;

    return this.datasourceSrv.get(this.panel.selectedDatasource).then( (ds) => {
      const payload: any = {
        'db': ds.database,
        'q': 'SELECT * FROM events ' + where + limit,
      };
      const dashboardId = this.dashboard.id;

      return this.backendSrv.$http({
        url: ds.urls[0] + '/query',
        method: 'GET',
        params: payload,
      }).then((result) => {
        let found: any[] = [];
        // No series
        if (result.data.results[0].series === undefined) {
          this.found = found;
          return;
        }

        result.data.results[0].series[0].values.forEach(function (v){
          let anno: { [key: string]: any; } = {};
          zip(result.data.results[0].series[0].columns, v).forEach(function (d) {
            if (d[0] === 'tags') {
              anno[d[0]] = d[1] ? d[1].split(',') : [];
            } else {
              anno[d[0]] = d[1];
            }

          });
          if (anno['dashboardId'] === undefined) {
            anno['dashboardId'] = dashboardId;
          }
          found.push(anno);
        })
        this.found = found;
      }, err => {
          console.log( "ERROR", err );
      });
    });
  }

  getAnnotationSearch(): Promise<any> {
    // http://docs.grafana.org/http_api/annotations/
    // https://github.com/grafana/grafana/blob/master/public/app/core/services/backend_srv.ts
    // https://github.com/grafana/grafana/blob/master/public/app/features/annotations/annotations_srv.ts

    const params: any = {
      tags: this.panel.tags,
      limit: this.panel.limit,
      type: 'annotation', // Skip the Annotations that are really alerts.  (Use the alerts panel!)
    };

    if (this.panel.onlyFromThisDashboard) {
      params.dashboardId = this.dashboard.id;
    }

    let timeInfo = '';
    if (this.panel.onlyInTimeRange) {
      let range = this.timeSrv.timeRange();
      params.from = range.from.valueOf();
      params.to = range.to.valueOf();
    } else {
      timeInfo = 'All Time';
    }
    this.timeInfo = timeInfo;

    if (this.queryUserId !== undefined) {
      params.userId = this.queryUserId;
      this.timeInfo += ' ' + this.queryUser;
    }

    if (this.panel.selectedDatasource === this.defaultDatasource) {
      // -- Grafana --
      return this.backendSrv.get('/api/annotations', params).then(result => {
        this.found = result;
      });
    } else {
      // InfluxDB
      return this._promiseAnnotationFromInfluxDB(params);
    }
  }

  _timeOffset(time: number, offset: string, subtract: boolean = false) {
    let incr = 5;
    let unit = 'm';
    let parts = /^(\d+)(\w)/.exec(offset);
    if (parts && parts.length === 3) {
      incr = parseInt(parts[1]);
      unit = parts[2];
    }

    let t = moment.utc(time);
    if (subtract) {
      incr *= -1;
    }
    t.add(incr, unit);
    return t;
  }

  selectAnno(anno: any, evt?: any) {
    if (evt) {
      evt.stopPropagation();
      evt.preventDefault();
    }
    let range = {
      from: this._timeOffset(anno.time, this.panel.navigateBefore, true),
      to: this._timeOffset(anno.time, this.panel.navigateAfter, false),
    };

    // Link to the panel on the same dashboard
    if (this.dashboard.id === anno.dasboardId) {
      this.timeSrv.setTime(range);
      if (this.panel.navigateToPanel) {
        this.$location.search('panelId', anno.panelId);
        this.$location.search('fullscreen', true);
      }
      return;
    }

    if (anno.dashboardId === 0) {
      this.$rootScope.appEvent('alert-warning', [
        'Invalid Annotation Dashboard',
        'Annotation on dashboard: 0 (new?)',
      ]);
      return;
    }

    let dashboardId;
    if (this.panel.navigateToDashboard) {
      dashboardId = anno.dashboardId;
    } else {
      dashboardId = this.dashboard.id;
    }

    this.backendSrv.get('/api/search', {dashboardIds: dashboardId}).then(res => {
      if (res && res.length === 1 && res[0].id === dashboardId) {
        const dash = res[0];
        let path = dash.url;
        if (!path) {
          // before v5.
          path = '/dashboard/' + dash.uri;
        }

        let params: any = {
          from: range.from.valueOf().toString(),
          to: range.to.valueOf().toString(),
        };
        if (this.panel.navigateToPanel) {
          params.panelId = anno.panelId;
          params.fullscreen = true;
        }
        const orgId = this.$location.search().orgId;
        if (orgId) {
          params.orgId = orgId;
        }
        this.$location.path(path).search(params);
      } else {
        console.log('Unable to find dashboard...', anno);
        this.$rootScope.appEvent('alert-warning', [
          'Unknown Dashboard: ' + dashboardId,
        ]);
      }
    });
  }

  queryAnnotationUser(anno: any, evt?: any) {
    if (evt) {
      evt.stopPropagation();
      evt.preventDefault();
    }
    if (this.queryUserId === anno.userId) {
      // Reset user filter
      this.queryUserId = undefined;
      this.queryUser = undefined;
    
    } else {
      // Set user filter
      this.queryUserId = anno.userId;
      this.queryUser = anno.login;
    }
    this.refresh();
  }

  queryAnnotationTag(anno: any, tag: string, evt?: any) {
    if (evt) {
      evt.stopPropagation();
      evt.preventDefault();
    }

    if (this.panel.tags.indexOf(tag) > -1) {
      // Remove exists tag
      this.panel.tags = _.without(this.panel.tags, tag);

    } else if (tag) {
      // Append tag
      this.panel.tags.push(tag);
    } else {
      // Reset tags
      this.panel.tags = [];
    }

    this.refresh();
  }
}

export {AnnoListCtrl, AnnoListCtrl as PanelCtrl};
