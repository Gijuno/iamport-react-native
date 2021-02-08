
import React, { useState, useEffect } from 'react';
import PropTypes from 'prop-types';
import { WebView } from 'react-native-webview';
import { View, Linking, Platform, NativeModules } from 'react-native';

import Loading from '../Loading';
import ErrorOnParams from '../ErrorOnParams';

import IamportUrl from '../../utils/IamportUrl.js';
import ValidationForPayment from '../../utils/ValidationForPayment.js';
import { viewStyles } from '../../styles';
import {
  PAY_METHOD,
  CURRENCY,
  WEBVIEW_SOURCE_HTML,
  SMILEPAY_URL,
} from '../../constants';

const { RNCWebView } = NativeModules;

export function PaymentWebView({
  userCode,
  tierCode,
  data,
  loading,
  callback,
  open3rdPartyApp,
}) {
  const [webviewSource, setWebviewSource] = useState({ html: WEBVIEW_SOURCE_HTML });
  const [isWebViewLoaded, setIsWebViewLoaded] = useState(false);
  const [showLoading, setShowLoading] = useState(true);
  const [isInicisTransPaid, setIsInicisTransPaid] = useState(false);

  useEffect(() => {
    const { pg } = data;
    if (pg.startsWith('smilepay') && Platform.OS === 'ios') {
      /**
       * [feature/smilepay] IOS - 스마일페이 대비 코드 작성
       * 스마일페이 결제창을 iframe 방식으로 띄우기 때문에 WKWebView에서 서드 파티 쿠키가 허용되지 않아
       * WKWebView의 baseUrl을 강제로 스마일페이 URL로 적용
       */
      setWebviewSource({ ...webviewSource, baseUrl: SMILEPAY_URL });
    }
  }, []);

  useEffect(() => {
    function handleOpenURL(event) {
      const { pg, pay_method } = data;
      if (pay_method === 'trans') {
        const { url } = event;
        const iamportUrl = new IamportUrl(url);
        /**
         * [IOS] 웹 표준 이니시스 - 실시간 계좌이체 대비
         * 아래 로직대로 동작해야 최종적으로 결제가 승인된 후 콜백 함수가 호출됨
         * 1. 사파리 앱에서 복귀(app_scheme://imp_uid=%26merchant_uid=%26m_redirect_url=)
         * 2. 최종 결제 승인을 위해 이니시스가 HTTP 리퀘스트 호출
         * 3. "다음" 버튼이 있는 최종 화면으로 이동
         * 4. "다음" 버튼을 클릭
         * 5. 1번과 마찬가지로 app_scheme://imp_uid=%26merchant_uid=%26m_redirect_url=로 HTTP 리퀘스트 호출
         * 6. 콜백 함수 호출
         * 따라서 현재 handleOpenURL이 트리거 되는 사유가 1번 때문인지 5번 때문인지 구분이 필요하여
         * 이를 위한 isInicisTransPaid 플래그 추가
         */
        if (pg.startsWith('html5_inicis') && Platform.OS === 'ios') {
          if (isInicisTransPaid) {
            this.xdm.injectJavaScript(`
              window.location.href = "${IamportUrl.M_REDIRECT_URL}?${iamportUrl.getInicisTransQuery()}";
            `);
          } else {
            setIsInicisTransPaid(true);
          }
        }

        /* 나이스 - 실시간 계좌이체 대비 */
        if (pg.startsWith('nice')) {
          this.xdm.injectJavaScript(`
            window.location.href = "${IamportUrl.NICE_TRANS_URL}?${iamportUrl.getStringifiedQuery()}";
          `);
        }
      }
    }
    Linking.addEventListener('url', handleOpenURL);
    
    return function cleanup() {
      Linking.removeEventListener('url', handleOpenURL);
    }
  });

  function onLoadEnd() {
    if (!isWebViewLoaded) {
      // html이 load되고 최초 한번만 inject javascript
      data.m_redirect_url = IamportUrl.M_REDIRECT_URL;
      if (data.pg === 'eximbay') {
        data.popup = false;
      }

      if (tierCode) {
        this.xdm.injectJavaScript(`
          setTimeout(function() { IMP.agency("${userCode}", "${tierCode}"); });
        `);
      } else {
        this.xdm.injectJavaScript(`
          setTimeout(function() { IMP.init("${userCode}"); });
        `);
      }
      this.xdm.injectJavaScript(`
        setTimeout(function() {
          IMP.request_pay(${JSON.stringify(data)}, function(response) {
            window.ReactNativeWebView.postMessage(JSON.stringify(response));
          });
        });
      `);
      setIsWebViewLoaded(true);
    }

    // only for Android
    if (removeLoadingNeeded()) {
      setShowLoading(false);
    }
  }

  function removeLoadingNeeded() {
    const isAndroid = Platform.OS === 'android';
    if (showLoading && isAndroid) {
      // 로딩상태. 안드로이드 플랫폼
      if (isWebViewLoaded) {
        // 웹뷰 로드 끝. 리디렉션 방식
        return true;
      }
      // 웹뷰 로드 중. iframe 방식
      return isIframeWayPayment();
    }
    // IOS
    return false;
  }

  function isIframeWayPayment() {
    const { pg, pay_method, customer_uid } = data;
    if (pg.startsWith('html5_inicis') && customer_uid) {
      // 이니시스 빌링결제
      return true;
    }
    if (pg.startsWith('mobilians') && pay_method === 'phone') {
      // 모빌리언스 휴대폰 소액결제
      return true;
    }
    if (
      pg.startsWith('danal') || // 다날 일반결제
      pg.startsWith('danal_tpay') || // 다날 휴대폰 소액결제
      pg.startsWith('smilepay') || // 스마일페이
      pg.startsWith('payco') || // 페이코
      pg.startsWith('bluewalnut')  // 블루월넛
    ) {
      return true;
    }
    return false;
  }
  
  /* PG사가 callback을 지원하는 경우, 결제결과를 받아 callback을 실행한다 */
  function onMessage(e) {
    const { data } = e.nativeEvent;
    /**
     * [v1.6.0] 다날의 경우 response에 주문명(name)이 포함되어 있는데
     * 주문명에 %가 들어갈 경우, decodeURIComponent시 URI malformed 에러가 발생하는 것 대비해
     * 우선 encodeURIComponent를 한 후, decodeURIComponent가 끝나면
     * 최종적으로 decodeURIComponent를 한 번 더 한다
     */
    let response = encodeURIComponent(data);
    while(decodeURIComponent(response) !== data) {
      response = decodeURIComponent(response);
    }
    response = decodeURIComponent(response);
    response = JSON.parse(response);
    callback(response);
  }

  function onShouldStartLoadWithRequest(request) {
    const { url, lockIdentifier } = request;
    const iamportUrl = new IamportUrl(url);
    if (iamportUrl.isAppUrl()) {
      if (lockIdentifier === 0 /* && react-native-webview 버전이 v10.8.3 이상 */) {
        /**
         * [feature/react-native-webview] 웹뷰 첫 렌더링시 lockIdentifier === 0
         * 이때 무조건 onShouldStartLoadWithRequest를 true 처리하기 때문에
         * Error Loading Page 에러가 발생하므로
         * 강제로 lockIdentifier를 1로 변환시키도록 아래 네이티브 코드 호출
         */
        RNCWebView.onShouldStartLoadWithRequestCallback(false, lockIdentifier);
      }

      /* 3rd-party 앱 오픈 */
      open3rdPartyApp(iamportUrl);
      return false;
    }
    if (iamportUrl.isPaymentOver()) {
      callback(iamportUrl.getQuery());
      return false;
    }
    if (isWebViewLoaded && showLoading && iamportUrl.isIframeLoaded()) {
      /**
       * only for IOS
       * iframe이 load되면(url이 about:blank 또는 https://service.iamport.kr이 아니면)
       * webview의 loading 상태를 해제한다
       */
      setShowLoading(false);
    }
    return true;
  }

  const validation = new ValidationForPayment(userCode, loading, callback, data);
  if (validation.getIsValid()) {
    const { wrapper, loadingContainer, webViewContainer } = viewStyles;
    return (
      <View style={wrapper}>
        <View style={webViewContainer}>
          <WebView
            ref={(xdm) => this.xdm = xdm}
            useWebKit
            source={webviewSource}
            onLoadEnd={onLoadEnd}
            onMessage={onMessage}
            originWhitelist={['*']} // https://github.com/facebook/react-native/issues/19986
            sharedCookiesEnabled
            onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
          />
        </View>
        {
          showLoading &&
          <View style={loadingContainer}>
            {loading || <Loading />}
          </View>
        }
      </View>
    );
  }
  
  return <ErrorOnParams message={validation.getMessage()} />;
}

PaymentWebView.propTypes = {
  userCode: PropTypes.string.isRequired,
  tierCode: PropTypes.string,
  data: PropTypes.shape({
    pg: PropTypes.string,
    pay_method: PropTypes.oneOf(PAY_METHOD),
    currency: PropTypes.oneOf(CURRENCY),
    notice_url: PropTypes.oneOfType([
      PropTypes.string,
      PropTypes.arrayOf(PropTypes.string),
    ]),
    display: PropTypes.shape({
      card_quota: PropTypes.arrayOf(PropTypes.number),
    }),
    merchant_uid: PropTypes.string.isRequired,
    amount: PropTypes.oneOfType([
      PropTypes.string.isRequired,
      PropTypes.number.isRequired,
    ]),
    buyer_tel: PropTypes.string.isRequired,
    app_scheme: PropTypes.string.isRequired,
    escrow: PropTypes.bool,
    name: PropTypes.string,
    tax_free: PropTypes.number,
    buyer_name: PropTypes.string,
    buyer_email: PropTypes.string,
    buyer_addr: PropTypes.string,
    buyer_postcode: PropTypes.string,
    custom_data: PropTypes.object,
    vbank_due: PropTypes.string,
    popup: PropTypes.bool,
    digital: PropTypes.bool,
  }),
  callback: PropTypes.func.isRequired,
  loading: PropTypes.shape({
    message: PropTypes.string,
    image: PropTypes.oneOfType([
      PropTypes.string,
      PropTypes.number,
    ]),
  }),
  open3rdPartyApp: PropTypes.func.isRequired,
};

export default PaymentWebView;
